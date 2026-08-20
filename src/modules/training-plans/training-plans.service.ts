import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { MarathonsService } from '../marathons/marathons.service';
import type { Prisma } from '../../../generated/prisma/client';
import {
  TrainingPlanSessionStatus,
  TrainingPlanStatus,
  TrainingSessionType,
} from '../../../generated/prisma/enums';
import { ritmoBase, type Esfuerzo } from './pace-basis';
import {
  SEMANAS_MINIMAS,
  fechaLocal,
  lunesDe,
  lunesDesde,
  materializar,
  rangoRitmo,
  semanasConservadas,
  semanasDisponibles,
  sumarDias,
  type SesionMaterializada,
} from './plan-schedule';
import type {
  CompleteSessionDto,
  CreatePlanDto,
  ListTemplatesQueryDto,
  RescheduleSessionDto,
  RestartPlanDto,
} from './dto/training-plan.dto';

/**
 * Cuanto puede alejarse la distancia de una plantilla de la de la maraton para
 * seguir siendo "la misma carrera".
 *
 * Un maraton son 42195 m y media docena de organizadores lo publican como
 * 42000 o 42200. Exigir igualdad exacta dejaria sin sugerencias a medio
 * catalogo por un redondeo del afiche.
 */
const TOLERANCIA_DISTANCIA = 0.03;

/** Ventana de historial para estimar el ritmo base. */
const SEMANAS_DE_HISTORIAL = 12;

/** Tope de entrenamientos que se miran para estimar el ritmo. */
const MAX_ESFUERZOS = 50;

const DIA_MS = 86_400_000;

/** Estados en los que una sesion todavia se puede tocar. */
const SESION_ABIERTA: TrainingPlanSessionStatus[] = [
  TrainingPlanSessionStatus.pending,
  TrainingPlanSessionStatus.rescheduled,
];

const CAMPOS_PLANTILLA = {
  id: true,
  slug: true,
  name: true,
  description: true,
  goalDistanceMeters: true,
  level: true,
  totalWeeks: true,
  weeklySessions: true,
  avgWeeklyDistanceMeters: true,
  coverUrl: true,
} as const;

const CAMPOS_SESION_PLANTILLA = {
  id: true,
  week: true,
  weekday: true,
  type: true,
  targetDistanceMeters: true,
  targetDurationSeconds: true,
  paceFactor: true,
  description: true,
  isKeySession: true,
} as const;

type FilaSesionPlantilla = Prisma.TrainingPlanTemplateSessionGetPayload<{
  select: typeof CAMPOS_SESION_PLANTILLA;
}>;

/** Lo que se trae del plan para poder devolverlo sin una segunda consulta. */
const PLAN_CON_CONTEO = {
  marathon: { select: { id: true, name: true } },
  _count: { select: { sessions: true } },
} as const;

type FilaPlan = Prisma.TrainingPlanGetPayload<{ include: typeof PLAN_CON_CONTEO }>;

/** La sesion con lo unico que le falta a la fila: el texto de la plantilla. */
const SESION_CON_PLANTILLA = {
  templateSession: { select: { description: true, isKeySession: true } },
} as const;

type FilaSesion = Prisma.TrainingPlanSessionGetPayload<{ include: typeof SESION_CON_PLANTILLA }>;

@Injectable()
export class TrainingPlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly marathons: MarathonsService,
    private readonly config: AppConfigService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  //  Catalogo de plantillas
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Sin paginacion, a proposito: el catalogo son ocho plantillas y crecera a
   * decenas, no a miles. Un cursor aqui seria maquinaria para un problema que
   * todavia no existe, y el dia que exista se agrega `meta.nextCursor` sin
   * romper a ningun cliente.
   */
  async plantillas(query: ListTemplatesQueryDto) {
    return this.prisma.trainingPlanTemplate.findMany({
      where: {
        isActive: true,
        goalDistanceMeters: query.goalDistance,
        level: query.level,
        totalWeeks: query.weeks,
      },
      orderBy: [{ goalDistanceMeters: 'asc' }, { totalWeeks: 'asc' }],
      select: CAMPOS_PLANTILLA,
    });
  }

  /** Detalle con todas las sesiones. Acepta el slug o el id. */
  async plantilla(slugOId: string) {
    const plantilla = await this.prisma.trainingPlanTemplate.findFirst({
      where: { isActive: true, OR: [{ slug: slugOId }, { id: slugOId }] },
      select: {
        ...CAMPOS_PLANTILLA,
        sessions: {
          orderBy: [{ week: 'asc' }, { weekday: 'asc' }],
          select: CAMPOS_SESION_PLANTILLA,
        },
      },
    });

    if (!plantilla) throw this.noExiste('La plantilla no existe');
    return plantilla;
  }

  /**
   * Plantillas que sirven para una maraton concreta, ordenadas por ajuste.
   *
   * No se descartan las que no entran enteras: se devuelven con `fits: false` y
   * las semanas que quedarian tras el recorte. Quien tiene 9 semanas para una
   * media prefiere ver "este plan de 12 se recorta a 9" antes que una lista
   * vacia — y donde recortar ya lo sabe `plan-schedule`.
   */
  async sugerencias(marathonSlugOId: string) {
    const maraton = await this.marathons.buscarVisibleOFallar(marathonSlugOId);
    const disponibles = this.semanasHasta(maraton);

    const margen = maraton.distanceMeters * TOLERANCIA_DISTANCIA;
    const plantillas = await this.prisma.trainingPlanTemplate.findMany({
      where: {
        isActive: true,
        goalDistanceMeters: {
          gte: Math.round(maraton.distanceMeters - margen),
          lte: Math.round(maraton.distanceMeters + margen),
        },
      },
      orderBy: { totalWeeks: 'asc' },
      select: CAMPOS_PLANTILLA,
    });

    return (
      plantillas
        .map((template) => {
          const semanas = semanasConservadas(template.totalWeeks, disponibles);
          return {
            template,
            weeksAvailable: Math.max(disponibles, 0),
            fits: semanas.length === template.totalWeeks,
            effectiveWeeks: semanas.length,
          };
        })
        .filter((s) => s.effectiveWeeks > 0)
        // Primero las que entran enteras; dentro de cada grupo, la mas larga:
        // mas semanas de preparacion es mejor cuando el tiempo alcanza.
        .sort((a, b) => Number(b.fits) - Number(a.fits) || b.effectiveWeeks - a.effectiveWeeks)
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Instanciacion
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Crea el plan del usuario a partir de una plantilla.
   *
   * Con maraton objetivo el plan se **ancla por el final**: la ultima semana es
   * la de la carrera y de ahi hacia atras. Anclarlo por el principio dejaria el
   * tapering a mitad de camino y el pico de carga tres dias antes de largar.
   */
  async crear(userId: string, dto: CreatePlanDto) {
    const plantilla = await this.plantilla(dto.templateId);
    const activo = await this.prisma.trainingPlan.findFirst({ where: { userId, isActive: true } });
    this.exigirConfirmacion(activo, dto.replaceActive);

    const maraton = dto.marathonId
      ? await this.marathons.buscarVisibleOFallar(dto.marathonId)
      : null;

    const disponibles = maraton ? this.semanasHasta(maraton) : plantilla.totalWeeks;
    const semanas = semanasConservadas(plantilla.totalWeeks, disponibles);
    if (semanas.length === 0) {
      throw new AppException(
        ErrorCode.PLAN_DOES_NOT_FIT,
        `Faltan muy pocas semanas para preparar esa carrera: hacen falta al menos ${SEMANAS_MINIMAS}.`,
        HttpStatus.CONFLICT,
        [{ weeksAvailable: Math.max(disponibles, 0), minimumWeeks: SEMANAS_MINIMAS }],
      );
    }

    // Con maraton el arranque sale de restar las semanas del plan a la semana
    // de la carrera; sin ella, del lunes que pidio el usuario.
    const lunesInicial = maraton
      ? sumarDias(this.lunesDeLaCarrera(maraton), -(semanas.length - 1) * 7)
      : lunesDesde(dto.startDate ? this.aFecha(dto.startDate) : new Date());

    const base = ritmoBase(
      await this.esfuerzosRecientes(userId),
      plantilla.goalDistanceMeters,
      plantilla.level,
    );

    const sesiones = materializar(plantilla.sessions, semanas, lunesInicial);

    const plan = await this.prisma.$transaction(async (tx) => {
      if (activo) await this.cerrarActivo(tx, activo.id);

      return tx.trainingPlan.create({
        data: {
          userId,
          templateId: plantilla.id,
          marathonId: maraton?.id ?? null,
          name: maraton ? `${plantilla.name} — ${maraton.name}` : plantilla.name,
          totalWeeks: semanas.length,
          startDate: lunesInicial,
          endDate: sumarDias(lunesInicial, semanas.length * 7 - 1),
          paceBasisSecPerKm: base.paceBasisSecPerKm,
          sessions: { create: sesiones.map((s) => this.aSesion(s, base.paceBasisSecPerKm)) },
        },
        include: PLAN_CON_CONTEO,
      });
    });

    return { ...this.toPlan(plan, 0), paceBasisSource: base.source };
  }

  /**
   * Vuelve a materializar el mismo plan desde cero con otra fecha de arranque.
   *
   * Borra las sesiones y las rehace en vez de correr las fechas: un plan que se
   * reinicia empieza de verdad, y arrastrar los "completado" de la vez anterior
   * daria una semana 1 ya hecha antes de empezar.
   */
  async reiniciar(userId: string, planId: string, dto: RestartPlanDto) {
    const plan = await this.buscarPlanPropio(userId, planId);
    if (!plan.templateId) {
      throw this.noExiste('Ese plan no viene de una plantilla y no se puede reiniciar');
    }

    const otroActivo = await this.prisma.trainingPlan.findFirst({
      where: { userId, isActive: true, id: { not: plan.id } },
    });
    this.exigirConfirmacion(otroActivo, dto.replaceActive);

    const plantilla = await this.plantilla(plan.templateId);
    const lunesInicial = lunesDesde(dto.startDate ? this.aFecha(dto.startDate) : new Date());
    // Se conserva la duracion que ya tenia: si en su dia se recorto a 9
    // semanas, reiniciarlo no puede devolverle las 16 de la plantilla.
    const semanas = semanasConservadas(plantilla.totalWeeks, plan.totalWeeks);
    const sesiones = materializar(plantilla.sessions, semanas, lunesInicial);

    const actualizado = await this.prisma.$transaction(async (tx) => {
      if (otroActivo) await this.cerrarActivo(tx, otroActivo.id);
      await tx.trainingPlanSession.deleteMany({ where: { planId: plan.id } });

      return tx.trainingPlan.update({
        where: { id: plan.id },
        data: {
          status: TrainingPlanStatus.active,
          isActive: true,
          totalWeeks: semanas.length,
          startDate: lunesInicial,
          endDate: sumarDias(lunesInicial, semanas.length * 7 - 1),
          sessions: { create: sesiones.map((s) => this.aSesion(s, plan.paceBasisSecPerKm)) },
        },
        include: PLAN_CON_CONTEO,
      });
    });

    return this.toPlan(actualizado, 0);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Gestion del plan
  // ─────────────────────────────────────────────────────────────────────────

  /** Plan activo + historial. Es lo que pinta la pestana de entrenamiento. */
  async mios(userId: string) {
    const planes = await this.prisma.trainingPlan.findMany({
      where: { userId },
      orderBy: [{ isActive: 'desc' }, { startDate: 'desc' }],
      include: PLAN_CON_CONTEO,
    });

    const completadas = await this.completadasPorPlan(planes.map((p) => p.id));
    const salida = (p: FilaPlan) => this.toPlan(p, completadas.get(p.id) ?? 0);
    const activo = planes.find((p) => p.isActive);

    return {
      active: activo ? salida(activo) : null,
      history: planes.filter((p) => !p.isActive).map(salida),
    };
  }

  /**
   * Una semana del plan activo. Sin `week`, la que toca hoy.
   *
   * Antes de que el plan empiece devuelve la semana 1 y despues del final la
   * ultima: el selector de semana del cliente no tiene que saber de bordes.
   */
  async semanaActual(userId: string, week?: number) {
    const plan = await this.prisma.trainingPlan.findFirst({
      where: { userId, isActive: true },
      include: PLAN_CON_CONTEO,
    });
    if (!plan) throw this.noExiste('No tienes un plan activo');

    const pedida = week ?? this.semanaDe(plan) ?? 1;
    const semana = Math.min(Math.max(pedida, 1), plan.totalWeeks);

    const sessions = await this.prisma.trainingPlanSession.findMany({
      where: { planId: plan.id, week: semana },
      orderBy: [{ scheduledDate: 'asc' }, { weekday: 'asc' }],
      include: SESION_CON_PLANTILLA,
    });

    const completadas = await this.completadasPorPlan([plan.id]);

    return {
      plan: this.toPlan(plan, completadas.get(plan.id) ?? 0),
      week: semana,
      sessions: sessions.map((s) => this.toSesion(s)),
    };
  }

  /**
   * Marca una sesion como hecha (o saltada).
   *
   * Cuando no queda ninguna abierta el plan pasa a `completed` solo: nadie
   * entra a la app a pulsar "terminar plan", y un plan que se queda `active`
   * para siempre bloquea el siguiente.
   */
  async completarSesion(userId: string, sessionId: string, dto: CompleteSessionDto) {
    const sesion = await this.buscarSesionPropia(userId, sessionId);
    this.exigirAbierta(sesion.status);
    if (dto.workoutId) await this.exigirWorkoutPropio(userId, dto.workoutId);

    const actualizada = await this.prisma.trainingPlanSession.update({
      where: { id: sesion.id },
      data: {
        status: dto.skipped
          ? TrainingPlanSessionStatus.skipped
          : TrainingPlanSessionStatus.completed,
        workoutId: dto.workoutId ?? null,
      },
      include: SESION_CON_PLANTILLA,
    });

    await this.cerrarSiTermino(sesion.planId);
    return this.toSesion(actualizada);
  }

  /**
   * Mueve una sesion de dia, dentro del plan.
   *
   * Se guarda de donde venia (`rescheduledFromDate`) porque saber que la larga
   * del domingo se corrio al martes tres semanas seguidas dice mas del corredor
   * que la fecha nueva sola. La semana no cambia: mover una sesion no la saca
   * de su bloque de entrenamiento.
   */
  async reprogramarSesion(userId: string, sessionId: string, dto: RescheduleSessionDto) {
    const sesion = await this.buscarSesionPropia(userId, sessionId);
    this.exigirAbierta(sesion.status);

    const nueva = this.aFecha(dto.scheduledDate);
    if (nueva < sesion.plan.startDate || nueva > sesion.plan.endDate) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'La fecha queda fuera del plan',
        HttpStatus.BAD_REQUEST,
        [
          {
            startDate: sesion.plan.startDate.toISOString().slice(0, 10),
            endDate: sesion.plan.endDate.toISOString().slice(0, 10),
          },
        ],
      );
    }

    const actualizada = await this.prisma.trainingPlanSession.update({
      where: { id: sesion.id },
      data: {
        scheduledDate: nueva,
        // Solo la primera vez: reprogramar dos veces no debe borrar el origen.
        rescheduledFromDate: sesion.rescheduledFromDate ?? sesion.scheduledDate,
        status: TrainingPlanSessionStatus.rescheduled,
      },
      include: SESION_CON_PLANTILLA,
    });

    return this.toSesion(actualizada);
  }

  async abandonar(userId: string, planId: string) {
    const plan = await this.buscarPlanPropio(userId, planId);
    if (!plan.isActive) {
      throw new AppException(
        ErrorCode.PLAN_NOT_ACTIVE,
        'Ese plan ya no esta activo',
        HttpStatus.CONFLICT,
        [{ status: plan.status }],
      );
    }

    const actualizado = await this.prisma.trainingPlan.update({
      where: { id: plan.id },
      data: { status: TrainingPlanStatus.abandoned, isActive: false },
      include: PLAN_CON_CONTEO,
    });

    const completadas = await this.completadasPorPlan([plan.id]);
    return this.toPlan(actualizado, completadas.get(plan.id) ?? 0);
  }

  /**
   * Borrado real, no logico.
   *
   * Un plan es una proyeccion de una plantilla: se puede volver a generar en
   * cualquier momento. Lo que duele perder son los entrenamientos, y esos son
   * `Workout`: la relacion se pone a null al borrar, no cae en cascada.
   */
  async eliminar(userId: string, planId: string) {
    const plan = await this.buscarPlanPropio(userId, planId);
    await this.prisma.trainingPlan.delete({ where: { id: plan.id } });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Interno
  // ─────────────────────────────────────────────────────────────────────────

  /** Los entrenamientos de las ultimas semanas, para estimar el ritmo base. */
  private async esfuerzosRecientes(userId: string): Promise<Esfuerzo[]> {
    return this.prisma.workout.findMany({
      where: {
        userId,
        deletedAt: null,
        startedAt: { gte: sumarDias(new Date(), -SEMANAS_DE_HISTORIAL * 7) },
        distanceMeters: { gt: 0 },
      },
      select: { distanceMeters: true, durationSeconds: true },
      orderBy: { startedAt: 'desc' },
      take: MAX_ESFUERZOS,
    });
  }

  /** El lunes de la semana en que se corre esa maraton, en su propia zona. */
  private lunesDeLaCarrera(maraton: { startsAt: Date; timezone: string }): Date {
    return lunesDe(fechaLocal(maraton.startsAt, maraton.timezone));
  }

  private semanasHasta(maraton: { startsAt: Date; timezone: string }): number {
    return semanasDisponibles(this.hoy(), this.lunesDeLaCarrera(maraton));
  }

  /** Hoy como dia de calendario en la zona de la app. */
  private hoy(): Date {
    return fechaLocal(new Date(), this.config.get('DEFAULT_TIMEZONE'));
  }

  /** `2026-09-07` o un ISO completo → medianoche UTC de ese dia. */
  private aFecha(iso: string): Date {
    return new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  }

  private aSesion(
    s: SesionMaterializada<FilaSesionPlantilla>,
    paceBasisSecPerKm: number,
  ): Prisma.TrainingPlanSessionCreateWithoutPlanInput {
    const { plantilla } = s;
    // Un dia de descanso no tiene ritmo objetivo, y pintarle uno confunde.
    const ritmos =
      plantilla.type === TrainingSessionType.rest
        ? { paceMinSecPerKm: null, paceMaxSecPerKm: null }
        : rangoRitmo(paceBasisSecPerKm, plantilla.paceFactor);

    return {
      templateSession: { connect: { id: plantilla.id } },
      week: s.week,
      weekday: s.weekday,
      scheduledDate: s.scheduledDate,
      type: plantilla.type,
      targetDistanceMeters: plantilla.targetDistanceMeters,
      targetDurationSeconds: plantilla.targetDurationSeconds,
      ...ritmos,
    };
  }

  /**
   * Un plan activo sin confirmacion explicita del cliente es un error, no algo
   * que se resuelva por defecto: abandonar seis semanas de entrenamiento tiene
   * que ser una decision del usuario, no un efecto secundario.
   */
  private exigirConfirmacion(activo: { id: string; name: string } | null, confirmado?: boolean) {
    if (!activo || confirmado) return;

    throw new AppException(
      ErrorCode.PLAN_ALREADY_ACTIVE,
      'Ya tienes un plan activo. Confirma que quieres abandonarlo para empezar otro.',
      HttpStatus.CONFLICT,
      [{ activePlanId: activo.id, activePlanName: activo.name }],
    );
  }

  /** Deja el plan activo como abandonado. Se llama siempre dentro de una tx. */
  private async cerrarActivo(tx: Prisma.TransactionClient, planId: string) {
    await tx.trainingPlan.update({
      where: { id: planId },
      data: { status: TrainingPlanStatus.abandoned, isActive: false },
    });
  }

  private async cerrarSiTermino(planId: string) {
    const abiertas = await this.prisma.trainingPlanSession.count({
      where: { planId, status: { in: SESION_ABIERTA } },
    });
    if (abiertas > 0) return;

    await this.prisma.trainingPlan.update({
      where: { id: planId },
      data: { status: TrainingPlanStatus.completed, isActive: false },
    });
  }

  /** Sesiones completadas por plan, en una sola consulta y no una por plan. */
  private async completadasPorPlan(planIds: string[]): Promise<Map<string, number>> {
    if (planIds.length === 0) return new Map();

    const filas = await this.prisma.trainingPlanSession.groupBy({
      by: ['planId'],
      where: { planId: { in: planIds }, status: TrainingPlanSessionStatus.completed },
      _count: { _all: true },
    });

    return new Map(filas.map((f) => [f.planId, f._count._all]));
  }

  private async buscarPlanPropio(userId: string, planId: string) {
    const plan = await this.prisma.trainingPlan.findFirst({ where: { id: planId, userId } });
    if (!plan) throw this.noExiste('El plan no existe');
    return plan;
  }

  /**
   * La sesion con su plan, comprobando de paso que el plan sea de este usuario.
   *
   * El filtro por `plan.userId` va dentro de la consulta y no en un `if`
   * posterior: asi no existe ninguna version del codigo que llegue a tener la
   * fila ajena en memoria antes de decidir que no podia verla.
   */
  private async buscarSesionPropia(userId: string, sessionId: string) {
    const sesion = await this.prisma.trainingPlanSession.findFirst({
      where: { id: sessionId, plan: { userId } },
      include: { plan: { select: { id: true, startDate: true, endDate: true } } },
    });
    if (!sesion) throw this.noExiste('La sesion no existe');
    return sesion;
  }

  private async exigirWorkoutPropio(userId: string, workoutId: string) {
    const existe = await this.prisma.workout.findFirst({
      where: { id: workoutId, userId, deletedAt: null },
      select: { id: true },
    });
    if (!existe) throw this.noExiste('El entrenamiento no existe');
  }

  private exigirAbierta(status: TrainingPlanSessionStatus) {
    if (SESION_ABIERTA.includes(status)) return;

    throw new AppException(
      ErrorCode.SESSION_NOT_PENDING,
      'Esa sesion ya esta cerrada',
      HttpStatus.CONFLICT,
      [{ status }],
    );
  }

  /** En que semana del plan cae hoy. `null` si el plan no esta en curso. */
  private semanaDe(plan: { startDate: Date; totalWeeks: number }): number | null {
    const dias = Math.floor((this.hoy().getTime() - plan.startDate.getTime()) / DIA_MS);
    const semana = Math.floor(dias / 7) + 1;
    return semana >= 1 && semana <= plan.totalWeeks ? semana : null;
  }

  private toPlan(plan: FilaPlan, completedSessions: number) {
    return {
      id: plan.id,
      name: plan.name,
      templateId: plan.templateId,
      marathonId: plan.marathonId,
      marathonName: plan.marathon?.name ?? null,
      totalWeeks: plan.totalWeeks,
      startDate: plan.startDate.toISOString().slice(0, 10),
      endDate: plan.endDate.toISOString().slice(0, 10),
      paceBasisSecPerKm: plan.paceBasisSecPerKm,
      status: plan.status,
      isActive: plan.isActive,
      currentWeek: this.semanaDe(plan),
      totalSessions: plan._count.sessions,
      completedSessions,
    };
  }

  private toSesion(s: FilaSesion) {
    return {
      id: s.id,
      week: s.week,
      weekday: s.weekday,
      scheduledDate: s.scheduledDate.toISOString().slice(0, 10),
      type: s.type,
      targetDistanceMeters: s.targetDistanceMeters,
      targetDurationSeconds: s.targetDurationSeconds,
      paceMinSecPerKm: s.paceMinSecPerKm,
      paceMaxSecPerKm: s.paceMaxSecPerKm,
      description: s.templateSession?.description ?? null,
      isKeySession: s.templateSession?.isKeySession ?? false,
      status: s.status,
      rescheduledFromDate: s.rescheduledFromDate?.toISOString().slice(0, 10) ?? null,
      workoutId: s.workoutId,
    };
  }

  /**
   * Un plan ajeno responde 404, no 403.
   *
   * Igual que en inscripciones: distinguirlos le confirmaria a un curioso que
   * el id existe y es de otro.
   */
  private noExiste(mensaje: string): AppException {
    return new AppException(ErrorCode.NOT_FOUND, mensaje, HttpStatus.NOT_FOUND);
  }
}

import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../database/prisma.service';
import { MarathonsService } from '../marathons/marathons.service';
import { TrainingPlansService } from '../training-plans/training-plans.service';
import { WorkoutsService } from '../workouts/workouts.service';
import { fechaLocal } from '../training-plans/plan-schedule';
import { RegistrationStatus } from '../../../generated/prisma/enums';
import { PredictionService } from './prediction.service';
import type { Prediccion } from './prediction';

/** Una sesion del plan, tal como la devuelve `TrainingPlansService`. */
type SesionDelPlan = Awaited<ReturnType<TrainingPlansService['semanaActual']>>['sessions'][number];

/**
 * El home en una sola llamada.
 *
 * La pantalla de inicio necesita cinco cosas de cuatro modulos distintos. Con un
 * endpoint por cosa, arrancar la app son cinco peticiones en serie sobre una red
 * movil boliviana —y cinco oportunidades de que una falle y la pantalla quede a
 * medias—. Aqui se resuelven juntas y en paralelo.
 *
 * **No calcula nada propio**: pide a cada modulo lo que ya sabe responder y lo
 * cose. El dia que cambie como se cuenta una semana de plan, cambia en planes y
 * el home se entera solo.
 */
@Injectable()
export class HomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly marathons: MarathonsService,
    private readonly plans: TrainingPlansService,
    private readonly workouts: WorkoutsService,
    private readonly predictions: PredictionService,
  ) {}

  async summary(userId: string) {
    const [destacada, planes, stats] = await Promise.all([
      this.destacada(userId),
      this.plans.mios(userId),
      this.workouts.statsSemanales(userId, { weeks: 1 }),
    ]);

    const activo = planes.active;
    // La semana solo se pide si hay plan: `semanaActual` falla sin plan activo,
    // y preguntar para descartar el error seria pedirle a Postgres que haga de
    // condicional.
    const semana = activo ? await this.plans.semanaActual(userId) : null;

    const hoy = fechaLocal(new Date(), this.config.get('DEFAULT_TIMEZONE'))
      .toISOString()
      .slice(0, 10);

    const sesiones = semana?.sessions ?? [];
    const tira = stats.weeks[0]!;

    return {
      featuredMarathon: destacada.marathon,
      prediction: destacada.prediction,
      plan: activo,
      planWeek: semana ? { week: semana.week, sessions: sesiones } : null,
      todaySession: sesiones.find((s) => s.scheduledDate === hoy) ?? null,
      week: {
        ...tira,
        timezone: stats.timezone,
        days: tira.days.map((dia) => ({
          ...dia,
          ...this.planDelDia(sesiones, this.diaLocal(dia.startsAt)),
        })),
      },
    };
  }

  /**
   * La maraton que abre la pantalla.
   *
   * Manda **la que el usuario ya pago**: la carrera propia es la que tiene una
   * cuenta regresiva que le importa, y taparla con una promocionada seria
   * publicidad en el sitio donde el corredor mira su dorsal. Sin inscripcion se
   * cae a la proxima del catalogo, que ahi si es una invitacion.
   */
  private async destacada(userId: string) {
    const inscripcion = await this.prisma.registration.findFirst({
      where: {
        userId,
        deletedAt: null,
        status: RegistrationStatus.confirmed,
        marathon: { startsAt: { gt: new Date() } },
      },
      orderBy: { marathon: { startsAt: 'asc' } },
      select: { id: true, bibNumber: true, marathonId: true },
    });

    const marathon = inscripcion
      ? await this.marathons.resumen(inscripcion.marathonId)
      : ((await this.marathons.proximas(1))[0] ?? null);

    if (!marathon) return { marathon: null, prediction: null };

    return {
      marathon: {
        ...marathon,
        registrationId: inscripcion?.id ?? null,
        bibNumber: inscripcion?.bibNumber ?? null,
        isRegistered: inscripcion !== null,
      },
      prediction: await this.prediccionPara(userId, marathon.distanceMeters),
    };
  }

  /**
   * Nunca lanza: sin historial devuelve `insufficient_data`, que es un estado
   * legitimo de la pantalla y no un fallo.
   */
  private prediccionPara(userId: string, distanceMeters: number): Promise<Prediccion> {
    return this.predictions.estimar(userId, distanceMeters);
  }

  /** Fecha de calendario, en la zona del proyecto, de un instante cualquiera. */
  private diaLocal(iso: string): string {
    return fechaLocal(new Date(iso), this.config.get('DEFAULT_TIMEZONE'))
      .toISOString()
      .slice(0, 10);
  }

  /**
   * Lo que el plan pedia para ese dia.
   *
   * Se cruza por **fecha**, no por `weekday`: la semana del plan y la semana del
   * calendario coinciden mientras el plan esta en curso, pero un plan que ya
   * termino devuelve su ultima semana, y casar por dia de la semana pintaria las
   * sesiones de marzo sobre la tira de hoy.
   *
   * Si hay dos sesiones el mismo dia —raro, pero una reprogramacion puede
   * juntarlas— gana la que sigue abierta: la casilla de la tira sirve para
   * recordar lo que falta, no para celebrar lo hecho.
   */
  private planDelDia(sesiones: readonly SesionDelPlan[], fecha: string) {
    const delDia = sesiones.filter((s) => s.scheduledDate === fecha);
    const sesion = delDia.find((s) => s.status === 'pending') ?? delDia[0];

    return {
      plannedDistanceMeters: sesion?.targetDistanceMeters ?? null,
      sessionId: sesion?.id ?? null,
      sessionType: sesion?.type ?? null,
      sessionStatus: sesion?.status ?? null,
    };
  }
}

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { esCiValida, normalizarCi } from '../auth/ci';
import { hashPassword } from '../auth/password';
import { PaymentsService } from '../payments/payments.service';
import { PaymentProofService } from '../payments/manual-qr/payment-proof.service';
import { RegistrationsService } from '../registrations/registrations.service';
import { PaymentMethod, PaymentStatus } from '../../../generated/prisma/enums';
import type { Payment } from '../../../generated/prisma/client';
import type { PublicRegistrationDto } from './dto/public-registration.dto';

/**
 * TEMPORAL — inscripcion desde la web publica. Ver `docs/pago-qr-manual.md`.
 *
 * **No reimplementa nada.** Resuelve una cosa que la API no tenia —quien es el
 * corredor, cuando no hay sesion— y a partir de ahi llama a los mismos
 * servicios que usa la app: `RegistrationsService` para el borrador y los
 * extras, `PaymentsService` para abrir el cobro. Una segunda implementacion de
 * "inscribir" es como se acaba con dos precios distintos para la misma carrera.
 *
 * La identidad es la **CI**. Es lo unico que la persona lleva encima tanto si
 * ya tenia la app instalada como si nunca la abrio, y es lo que hace que pagar
 * en la web y hacer seguimiento en el movil sea la misma inscripcion.
 */
@Injectable()
export class PublicRegistrationService {
  private readonly logger = new Logger(PublicRegistrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registrations: RegistrationsService,
    private readonly payments: PaymentsService,
    private readonly proofs: PaymentProofService,
    private readonly config: AppConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  //  Alta
  // ---------------------------------------------------------------------------

  async inscribir(dto: PublicRegistrationDto) {
    this.exigirHabilitado();

    const ci = normalizarCi(dto.personalData.docId);

    if (!esCiValida(ci)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'La CI no tiene un formato valido',
        HttpStatus.BAD_REQUEST,
      );
    }

    const cuenta = await this.resolverCuenta(ci, dto.personalData);

    // Paso 1 y 2, con los mismos metodos que usa la app. `crear` es idempotente
    // por (usuario, maraton): reenviar el formulario no abre una segunda
    // inscripcion, la actualiza.
    const borrador = await this.registrations.crear(cuenta.userId, {
      marathonId: dto.marathonId,
      personalData: dto.personalData,
    });

    await this.registrations.actualizarCategoriaYExtras(cuenta.userId, borrador.id, {
      categoryId: dto.categoryId ?? null,
      extras: dto.extras ?? [],
    });

    const pago = await this.abrirCobro(cuenta.userId, borrador.id);
    const token = await this.emitirToken(borrador.id);
    const qr = detalleDeQr(pago.methodDetails);

    this.logger.log(
      `Inscripcion publica ${borrador.id} (CI ${ci}, cuenta ${cuenta.created ? 'nueva' : 'existente'})`,
    );

    return {
      registrationId: borrador.id,
      publicToken: token,
      paymentId: pago.id,
      paymentStatus: pago.status,
      totalCents: pago.amountCents,
      currency: pago.currency,
      qr,
      expiresAt: pago.expiresAt?.toISOString() ?? null,
      account: { created: cuenta.created, username: ci, mustChangePassword: cuenta.debeCambiar },
    };
  }

  // ---------------------------------------------------------------------------
  //  Comprobante y estado, autorizados por el token
  // ---------------------------------------------------------------------------

  async subirComprobante(
    registrationId: string,
    token: string,
    archivo: { buffer: Buffer; size: number },
    referencia?: string,
  ) {
    this.exigirHabilitado();

    const registro = await this.autorizar(registrationId, token);
    const pago = await this.cobroAbiertoDe(registro.id);

    if (!pago) {
      throw new AppException(
        ErrorCode.PROOF_NOT_ALLOWED,
        'Esta inscripcion no tiene un cobro abierto',
        HttpStatus.CONFLICT,
      );
    }

    return this.proofs.subir(pago.id, archivo, referencia);
  }

  async estado(registrationId: string, token: string) {
    this.exigirHabilitado();

    const registro = await this.autorizar(registrationId, token);

    const pago = await this.prisma.payment.findFirst({
      where: { registrationId: registro.id },
      orderBy: { createdAt: 'desc' },
    });

    return {
      registrationId: registro.id,
      registrationStatus: registro.status,
      bibNumber: registro.bibNumber,
      paymentStatus: pago?.status ?? 'pending',
      proof: pago ? await this.proofs.ultimoDe(pago.id) : null,
    };
  }

  // ---------------------------------------------------------------------------
  //  Internos
  // ---------------------------------------------------------------------------

  private exigirHabilitado(): void {
    if (this.config.get('PUBLIC_REGISTRATION_ENABLED')) return;

    // 404 y no 403: un endpoint apagado no tiene por que anunciar que existe.
    throw new AppException(
      ErrorCode.NOT_FOUND,
      'La inscripcion en linea no esta disponible',
      HttpStatus.NOT_FOUND,
    );
  }

  /**
   * Encuentra la cuenta del corredor por CI, o la crea.
   *
   * Los tres caminos del enunciado terminan aqui:
   *
   * - Ya se registro en la app **con** su CI: se encuentra y no se toca nada.
   * - Ya se registro en la app **sin** CI, y ahora paga en la web: se encuentra
   *   por el email y se le completa la CI, que es lo que a partir de hoy la
   *   identifica en las dos puntas.
   * - No existe: se crea con usuario CI y contrasena CI, marcada para que la
   *   app le exija cambiarla la primera vez.
   *
   * La contrasena inicial es la CI **a sabiendas de que es publica**. Por eso
   * `mustChangePassword` no es opcional: la cuenta no sirve para nada hasta que
   * el usuario la cambie, y hasta entonces lo unico que hay dentro es su propia
   * inscripcion.
   */
  private async resolverCuenta(
    ci: string,
    datos: { fullName: string; email?: string },
  ): Promise<{ userId: string; created: boolean; debeCambiar: boolean }> {
    const porCi = await this.prisma.user.findUnique({ where: { ci } });

    if (porCi) {
      if (porCi.deletedAt) {
        throw new AppException(
          ErrorCode.CONFLICT,
          'Esa CI pertenece a una cuenta dada de baja',
          HttpStatus.CONFLICT,
        );
      }

      return { userId: porCi.id, created: false, debeCambiar: porCi.mustChangePassword };
    }

    if (datos.email) {
      const porEmail = await this.prisma.user.findUnique({ where: { email: datos.email } });

      if (porEmail && !porEmail.deletedAt) {
        // Ese email ya es de alguien con OTRA CI: o hay un dedazo o se esta
        // inscribiendo a un tercero con el correo propio. No se decide aqui.
        if (porEmail.ci && porEmail.ci !== ci) {
          throw new AppException(
            ErrorCode.EMAIL_ALREADY_REGISTERED,
            'Ese correo ya esta en uso por otra cuenta. Usa otro o inicia sesion en la app.',
            HttpStatus.CONFLICT,
          );
        }

        await this.prisma.user.update({ where: { id: porEmail.id }, data: { ci } });

        this.logger.log(`CI ${ci} vinculada a la cuenta existente ${porEmail.id}`);

        return { userId: porEmail.id, created: false, debeCambiar: porEmail.mustChangePassword };
      }
    }

    const usuario = await this.prisma.user.create({
      data: {
        ci,
        email: datos.email ?? null,
        name: datos.fullName,
        // Usuario = CI, contrasena = CI. Ver el comentario del metodo.
        passwordHash: await hashPassword(ci),
        mustChangePassword: true,
        profile: { create: {} },
        preferences: { create: {} },
      },
    });

    this.logger.log(`Cuenta ${usuario.id} creada desde la web para la CI ${ci}`);

    return { userId: usuario.id, created: true, debeCambiar: true };
  }

  /**
   * Abre el cobro por QR, o **devuelve el que ya estaba abierto**.
   *
   * Sin esto, reenviar el formulario deja dos cobros pendientes por la misma
   * inscripcion y dos QR con glosas distintas: el corredor paga uno y sube el
   * comprobante al otro.
   */
  private async abrirCobro(userId: string, registrationId: string): Promise<Payment> {
    const abierto = await this.cobroAbiertoDe(registrationId);
    if (abierto) return abierto;

    await this.payments.checkout(
      userId,
      registrationId,
      { termsAccepted: true, method: PaymentMethod.qr_manual },
      // La clave la genera el servidor porque el cliente de este endpoint es una
      // pagina web sin estado: no tiene donde guardarla entre reintentos. La
      // proteccion contra el doble cobro la da `cobroAbiertoDe()`, de arriba.
      `public-${registrationId}-${Date.now()}`,
    );

    const pago = await this.cobroAbiertoDe(registrationId);

    if (!pago) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        'No se pudo abrir el cobro',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return pago;
  }

  private cobroAbiertoDe(registrationId: string): Promise<Payment | null> {
    return this.prisma.payment.findFirst({
      where: {
        registrationId,
        method: PaymentMethod.qr_manual,
        status: PaymentStatus.pending,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Token opaco de 256 bits, unico por inscripcion.
   *
   * Se reemite en cada alta de la misma inscripcion: la web que reenvia el
   * formulario recibe uno nuevo y el anterior deja de valer. Es lo correcto —el
   * ultimo que lo pidio es el que esta delante de la pantalla— y hace que un
   * token filtrado en un log viejo no sirva para siempre.
   */
  private async emitirToken(registrationId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');

    await this.prisma.registration.update({
      where: { id: registrationId },
      data: { publicToken: token },
    });

    return token;
  }

  /**
   * El token **es** la autorizacion. Se compara en tiempo constante: es un
   * secreto de 256 bits y una comparacion que sale antes en el primer byte
   * distinto se puede medir.
   */
  private async autorizar(registrationId: string, token: string) {
    const registro = await this.prisma.registration.findFirst({
      where: { id: registrationId, deletedAt: null },
    });

    if (!registro?.publicToken || !iguales(registro.publicToken, token)) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'No se encontro esa inscripcion',
        HttpStatus.NOT_FOUND,
      );
    }

    return registro;
  }
}

function iguales(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);

  // `timingSafeEqual` exige la misma longitud; la diferencia de longitud no es
  // un secreto que valga nada aqui, el token siempre mide lo mismo.
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Lector del JSON de `methodDetails`, tolerante con una fila tocada a mano. */
function detalleDeQr(valor: unknown): {
  imageUrl: string;
  instructions: string | null;
  reference: string;
} {
  const qr = (valor as { manualQr?: Record<string, unknown> } | null)?.manualQr;

  return {
    imageUrl: typeof qr?.['imageUrl'] === 'string' ? qr['imageUrl'] : '',
    instructions: typeof qr?.['instructions'] === 'string' ? qr['instructions'] : null,
    reference: typeof qr?.['reference'] === 'string' ? qr['reference'] : '',
  };
}

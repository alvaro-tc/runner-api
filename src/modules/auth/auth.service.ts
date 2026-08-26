import { createHash, randomBytes } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { MailService } from '../mail/mail.service';
import { hashPassword } from './password';
import { esCiValida, esEmail, normalizarCi } from './ci';
import { DeviceInfo, TokenService } from './token.service';
import type {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
} from './dto/auth.dto';

/** Hash de una contrasena ficticia, para gastar tiempo cuando el email no existe. */
const DUMMY_HASH_PROMISE = hashPassword('contrasena-que-nunca-nadie-usa');

export interface UserPublic {
  id: string;
  email: string | null;
  ci: string | null;
  name: string;
  role: string;
  mustChangePassword: boolean;
  onboardingSeenAt: string | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    private readonly config: AppConfigService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  //  Registro y login
  // ─────────────────────────────────────────────────────────────────────────

  async register(dto: RegisterDto, device: DeviceInfo) {
    const ci = dto.ci ? normalizarCi(dto.ci) : null;

    if (ci && !esCiValida(ci)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'La CI no tiene un formato valido',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.exigirCredencialesLibres(dto.email ?? null, ci);

    const passwordHash = await hashPassword(dto.password);

    // Perfil y preferencias nacen con el usuario: asi ningun endpoint tiene que
    // preguntarse si existen, y `onboardingSeenAt` empieza en null de verdad.
    const user = await this.prisma.user.create({
      data: {
        email: dto.email ?? null,
        ci,
        passwordHash,
        name: dto.name,
        profile: { create: {} },
        preferences: { create: {} },
      },
      include: { preferences: true },
    });

    const pair = await this.tokens.issueForNewSession(user.id, user.role, device);

    return {
      ...pair,
      user: this.toPublic(user, user.preferences?.onboardingSeenAt ?? null),
    };
  }

  /**
   * Entra por email **o** por CI, con un solo campo.
   *
   * Cual de los dos es se decide por el `@` y no consultando la base: preguntar
   * primero por email y despues por CI duplicaria la consulta y, sobre todo,
   * abriria la puerta a responder distinto segun cual acerto. Aqui los dos
   * caminos terminan en el mismo error.
   */
  async login(dto: LoginDto, device: DeviceInfo) {
    const user = await this.buscarPorCredencial(dto.identifier);

    // Se verifica SIEMPRE un hash, exista el usuario o no. Sin esto, un email
    // inexistente responderia en 1 ms y uno real en 100 ms, y esa diferencia
    // permite averiguar quien tiene cuenta sin ni siquiera adivinar la clave.
    const hash = user?.passwordHash ?? (await DUMMY_HASH_PROMISE);
    const valida = await argon2.verify(hash, dto.password).catch(() => false);

    if (!user || !valida || user.deletedAt) {
      // Mensaje unico a proposito: no distingue "no existe" de "clave mala".
      throw new AppException(
        ErrorCode.INVALID_CREDENTIALS,
        'Email o contrasena incorrectos',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const pair = await this.tokens.issueForNewSession(user.id, user.role, device);

    return { ...pair, user: this.toPublic(user, user.preferences?.onboardingSeenAt ?? null) };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Sesion
  // ─────────────────────────────────────────────────────────────────────────

  refresh(refreshToken: string, device: DeviceInfo) {
    return this.tokens.rotate(refreshToken, device);
  }

  async logout(refreshToken: string): Promise<{ ok: true }> {
    await this.tokens.revokeByRefreshToken(refreshToken);
    return { ok: true };
  }

  async listSessions(userId: string, currentSessionId: string) {
    const sesiones = await this.prisma.authSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      select: {
        id: true,
        deviceId: true,
        deviceName: true,
        platform: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    });

    return sesiones.map((s) => ({ ...s, current: s.id === currentSessionId }));
  }

  async revokeSession(userId: string, sessionId: string): Promise<{ ok: true }> {
    // El filtro por userId es la autorizacion: nadie cierra la sesion de otro.
    // Si no le pertenece, el updateMany no toca nada y responde 404, sin
    // revelar si ese id existe.
    const { count } = await this.prisma.authSession.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    if (count === 0) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'No se encontro esa sesion activa',
        HttpStatus.NOT_FOUND,
      );
    }

    return { ok: true };
  }

  async me(userId: string): Promise<UserPublic> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { preferences: { select: { onboardingSeenAt: true } } },
    });

    if (!user || user.deletedAt) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Usuario no encontrado', HttpStatus.NOT_FOUND);
    }

    return this.toPublic(user, user.preferences?.onboardingSeenAt ?? null);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Recuperacion de contrasena
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Siempre responde lo mismo, exista el email o no.
   *
   * Si respondiera "ese email no esta registrado", este endpoint seria un
   * comprobador gratuito de quien tiene cuenta.
   */
  async forgotPassword(dto: ForgotPasswordDto): Promise<{ ok: true }> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true, email: true, name: true, deletedAt: true },
    });

    // Sin email no hay a donde mandar el enlace. Responde `ok` igual: la unica
    // regla de este endpoint es no decir nunca quien tiene cuenta.
    if (!user || user.deletedAt || !user.email) {
      this.logger.debug(`Recuperacion pedida para un email sin cuenta: ${dto.email}`);
      return { ok: true };
    }

    const token = randomBytes(32).toString('base64url');
    const minutos = this.config.get('PASSWORD_RESET_TTL_MINUTES');

    await this.prisma.$transaction([
      // Un enlace a la vez: pedir uno nuevo invalida el anterior.
      this.prisma.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
      this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: this.hashResetToken(token),
          expiresAt: new Date(Date.now() + minutos * 60 * 1000),
        },
      }),
    ]);

    await this.mail.send({
      // El guard de arriba ya descarto las cuentas sin email: sin correo no
      // hay recuperacion por correo que valga.
      to: user.email,
      subject: 'Recupera tu contrasena de PaceUp',
      body: [
        `Hola ${user.name},`,
        '',
        'Recibimos un pedido para cambiar tu contrasena. Usa este token:',
        '',
        `    ${token}`,
        '',
        `Vence en ${minutos} minutos. Si no fuiste vos, ignora este correo:`,
        'tu contrasena actual sigue funcionando.',
      ].join('\n'),
    });

    return { ok: true };
  }

  /**
   * Cambia la contrasena y **cierra todas las sesiones** del usuario.
   *
   * Es lo que se espera de un "recupere mi cuenta": si alguien habia entrado,
   * queda fuera. Obliga a volver a loguearse en los propios dispositivos, y es
   * el precio correcto.
   */
  async resetPassword(dto: ResetPasswordDto): Promise<{ ok: true }> {
    const registro = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: this.hashResetToken(dto.token) },
      include: { user: { select: { id: true, deletedAt: true } } },
    });

    if (
      !registro ||
      registro.usedAt ||
      registro.expiresAt <= new Date() ||
      registro.user.deletedAt
    ) {
      throw new AppException(
        ErrorCode.INVALID_RESET_TOKEN,
        'El enlace no es valido o ya vencio. Pedi uno nuevo.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const passwordHash = await hashPassword(dto.password);

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: registro.userId }, data: { passwordHash } }),
      this.prisma.passwordResetToken.update({
        where: { id: registro.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.authSession.updateMany({
        where: { userId: registro.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    this.logger.log(`Contrasena cambiada y sesiones revocadas (usuario ${registro.userId})`);
    return { ok: true };
  }

  // ─────────────────────────────────────────────────────────────────────────

  /** SHA-256: el token ya es aleatorio de 256 bits, no hay nada que estirar. */
  private hashResetToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private toPublic(
    user: {
      id: string;
      email: string | null;
      ci: string | null;
      name: string;
      role: string;
      mustChangePassword: boolean;
    },
    onboardingSeenAt: Date | null,
  ): UserPublic {
    return {
      id: user.id,
      email: user.email,
      ci: user.ci,
      name: user.name,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      onboardingSeenAt: onboardingSeenAt?.toISOString() ?? null,
    };
  }

  // -------------------------------------------------------------------------
  //  Credenciales
  // -------------------------------------------------------------------------

  /**
   * Busca al usuario por lo que sea que tecleo: email o CI.
   *
   * Devuelve `null` sin distinguir "no existe" de "no es un email valido": el
   * unico consumidor es `login()`, y ahi los dos casos responden igual.
   */
  private buscarPorCredencial(identificador: string) {
    const where = esEmail(identificador)
      ? { email: identificador }
      : { ci: normalizarCi(identificador) };

    return this.prisma.user.findUnique({
      where,
      include: { preferences: { select: { onboardingSeenAt: true } } },
    });
  }

  /**
   * Ni el email ni la CI pueden estar ya tomados.
   *
   * Se comprueba aqui ademas de en el indice unico porque el mensaje importa:
   * el error de Prisma no le dice a nadie cual de los dos choco.
   */
  private async exigirCredencialesLibres(email: string | null, ci: string | null): Promise<void> {
    if (email) {
      const previo = await this.prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });

      if (previo) {
        throw new AppException(
          ErrorCode.EMAIL_ALREADY_REGISTERED,
          'Ya existe una cuenta con ese email',
          HttpStatus.CONFLICT,
        );
      }
    }

    if (ci) {
      const previo = await this.prisma.user.findUnique({ where: { ci }, select: { id: true } });

      if (previo) {
        throw new AppException(
          ErrorCode.CI_ALREADY_REGISTERED,
          'Ya existe una cuenta con esa CI',
          HttpStatus.CONFLICT,
        );
      }
    }
  }

  /**
   * Cambia la contrasena de quien ya esta dentro.
   *
   * Cierra **las demas** sesiones y deja viva la actual: el caso principal es
   * el alta desde la web -contrasena inicial = CI, que la sabe cualquiera que
   * vea el documento- y echar al usuario del telefono justo despues de pedirle
   * que arregle eso convierte el arreglo en un castigo.
   *
   * Pide la contrasena actual aunque venga con token: un telefono desbloqueado
   * un minuto no puede convertirse en un cambio de credenciales.
   */
  async changePassword(
    userId: string,
    sessionId: string,
    dto: ChangePasswordDto,
  ): Promise<{ ok: true }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user || user.deletedAt) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Usuario no encontrado', HttpStatus.NOT_FOUND);
    }

    const valida = await argon2.verify(user.passwordHash, dto.currentPassword).catch(() => false);

    if (!valida) {
      throw new AppException(
        ErrorCode.INVALID_CREDENTIALS,
        'La contrasena actual no es correcta',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const passwordHash = await hashPassword(dto.newPassword);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash, mustChangePassword: false },
      }),
      this.prisma.authSession.updateMany({
        where: { userId, revokedAt: null, id: { not: sessionId } },
        data: { revokedAt: new Date() },
      }),
    ]);

    this.logger.log(`Contrasena cambiada por el propio usuario ${userId}`);
    return { ok: true };
  }
}

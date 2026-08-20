import { createHash, randomBytes } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { MailService } from '../mail/mail.service';
import { DeviceInfo, TokenService } from './token.service';
import type { ForgotPasswordDto, LoginDto, RegisterDto, ResetPasswordDto } from './dto/auth.dto';

/**
 * Parametros de argon2id.
 *
 * 64 MiB y 3 pasadas es la recomendacion de OWASP: caro para un atacante con
 * GPUs, imperceptible en un login (~100 ms). Aqui SI vale el coste, al reves
 * que en los refresh tokens, porque una contrasena humana si es atacable por
 * diccionario.
 */
const ARGON2_OPTS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
};

/** Hash de una contrasena ficticia, para gastar tiempo cuando el email no existe. */
const DUMMY_HASH_PROMISE = argon2.hash('contrasena-que-nunca-nadie-usa', ARGON2_OPTS);

export interface UserPublic {
  id: string;
  email: string;
  name: string;
  role: string;
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
    const existente = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true },
    });

    if (existente) {
      throw new AppException(
        ErrorCode.EMAIL_ALREADY_REGISTERED,
        'Ya existe una cuenta con ese email',
        HttpStatus.CONFLICT,
      );
    }

    const passwordHash = await argon2.hash(dto.password, ARGON2_OPTS);

    // Perfil y preferencias nacen con el usuario: asi ningun endpoint tiene que
    // preguntarse si existen, y `onboardingSeenAt` empieza en null de verdad.
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
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

  async login(dto: LoginDto, device: DeviceInfo) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { preferences: { select: { onboardingSeenAt: true } } },
    });

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

    if (!user || user.deletedAt) {
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

    const passwordHash = await argon2.hash(dto.password, ARGON2_OPTS);

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
    user: { id: string; email: string; name: string; role: string },
    onboardingSeenAt: Date | null,
  ): UserPublic {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      onboardingSeenAt: onboardingSeenAt?.toISOString() ?? null,
    };
  }
}

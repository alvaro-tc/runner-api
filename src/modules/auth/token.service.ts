import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { UserRole } from '../../../generated/prisma/enums';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { HttpStatus } from '@nestjs/common';

/** Lo que va firmado dentro del access token. Minimo a proposito. */
export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
  sessionId: string;
}

export interface TokenPair {
  accessToken: string;
  /** Cadena opaca. El servidor solo guarda su hash. */
  refreshToken: string;
  /** Segundos de vida del access token, para que el cliente programe el refresh. */
  expiresIn: number;
}

export interface DeviceInfo {
  deviceId: string;
  deviceName?: string;
  platform?: string;
  ip?: string;
  userAgent?: string;
}

/**
 * Emision y rotacion de tokens.
 *
 * El objetivo del disenio es que el usuario **no vuelva a loguearse en 60 dias
 * de uso normal**, sin que eso signifique un token eterno tirado en el
 * telefono. Se consigue con dos piezas:
 *
 *  - Access token JWT de 15 minutos: si se filtra, caduca solo.
 *  - Refresh opaco de 60 dias que ROTA en cada uso, recalculando su caducidad
 *    a 60 dias desde ahora. Mientras el usuario abra la app cada tanto, la
 *    ventana se desplaza y la sesion nunca muere.
 *
 * El refresh es opaco (bytes al azar), no un JWT: no lleva informacion, se
 * puede revocar de verdad, y el servidor guarda solo su hash. Si alguien roba
 * la base, no obtiene tokens usables.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * SHA-256, no argon2, a proposito.
   *
   * El refresh token ya son 256 bits de entropia criptografica: no hay
   * diccionario que atacar, asi que el coste de argon2 no compra nada y si
   * costaria ~100 ms en CADA refresh. Para contrasenas elegidas por humanos la
   * decision es la contraria (ver `AuthService`).
   */
  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Crea una sesion nueva para un dispositivo y devuelve el par de tokens. */
  async issueForNewSession(userId: string, role: UserRole, device: DeviceInfo): Promise<TokenPair> {
    const refreshToken = randomBytes(32).toString('base64url');

    const session = await this.prisma.authSession.create({
      data: {
        userId,
        refreshTokenHash: this.hashRefreshToken(refreshToken),
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        platform: device.platform,
        ip: device.ip,
        userAgent: device.userAgent,
        expiresAt: this.refreshExpiry(),
      },
    });

    return {
      accessToken: await this.signAccessToken({ sub: userId, role, sessionId: session.id }),
      refreshToken,
      expiresIn: this.accessTtlSeconds,
    };
  }

  /**
   * Rota un refresh token: invalida el usado y emite uno nuevo.
   *
   * Aqui vive la deteccion de reuso. Si llega un token cuya sesion ya esta
   * revocada, significa que alguien conserva una copia vieja — normalmente
   * porque la robo. En ese caso no basta con rechazar la peticion: se revoca
   * **toda la cadena de sesiones de ese dispositivo**, porque el atacante
   * podria tener tambien el token actual.
   */
  async rotate(refreshToken: string, device: DeviceInfo): Promise<TokenPair> {
    const hash = this.hashRefreshToken(refreshToken);

    const session = await this.prisma.authSession.findUnique({
      where: { refreshTokenHash: hash },
      include: { user: { select: { id: true, role: true, deletedAt: true } } },
    });

    if (!session || session.user.deletedAt) {
      throw new AppException(
        ErrorCode.INVALID_REFRESH_TOKEN,
        'La sesion no es valida. Volve a iniciar sesion.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (session.revokedAt) {
      await this.revokeDeviceChain(session.userId, session.deviceId);
      this.logger.warn(
        `Reuso de refresh token detectado (usuario ${session.userId}, dispositivo ${session.deviceId}). Cadena revocada.`,
      );
      throw new AppException(
        ErrorCode.TOKEN_REUSE_DETECTED,
        'Se detecto el reuso de un token. Por seguridad se cerraron las sesiones de este dispositivo.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (session.expiresAt <= new Date()) {
      throw new AppException(
        ErrorCode.INVALID_REFRESH_TOKEN,
        'La sesion expiro. Volve a iniciar sesion.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const nuevoRefresh = randomBytes(32).toString('base64url');

    // Revocar la vieja y crear la nueva en una transaccion: si algo falla, no
    // queda el usuario sin sesion valida ni con dos vivas a la vez.
    const nueva = await this.prisma.$transaction(async (tx) => {
      await tx.authSession.update({
        where: { id: session.id },
        data: { revokedAt: new Date(), lastUsedAt: new Date() },
      });

      return tx.authSession.create({
        data: {
          userId: session.userId,
          refreshTokenHash: this.hashRefreshToken(nuevoRefresh),
          deviceId: session.deviceId,
          deviceName: device.deviceName ?? session.deviceName,
          platform: device.platform ?? session.platform,
          ip: device.ip ?? session.ip,
          userAgent: device.userAgent ?? session.userAgent,
          // La ventana se desplaza: 60 dias desde AHORA, no desde el login.
          expiresAt: this.refreshExpiry(),
          rotatedFromId: session.id,
        },
      });
    });

    return {
      accessToken: await this.signAccessToken({
        sub: session.userId,
        role: session.user.role,
        sessionId: nueva.id,
      }),
      refreshToken: nuevoRefresh,
      expiresIn: this.accessTtlSeconds,
    };
  }

  /** Cierra una sesion. No borra la fila: queda el rastro de cuando se cerro. */
  async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeByRefreshToken(refreshToken: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { refreshTokenHash: this.hashRefreshToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Revoca todas las sesiones vivas de un dispositivo. */
  async revokeDeviceChain(userId: string, deviceId: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { userId, deviceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Revoca todo, en todos los dispositivos (cambio de contrasena). */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    return this.jwt.verifyAsync<AccessTokenPayload>(token);
  }

  private signAccessToken(payload: AccessTokenPayload): Promise<string> {
    return this.jwt.signAsync(payload, { expiresIn: `${this.accessTtlSeconds}s` });
  }

  private get accessTtlSeconds(): number {
    return this.config.get('ACCESS_TOKEN_TTL_MINUTES') * 60;
  }

  private refreshExpiry(): Date {
    const dias = this.config.get('REFRESH_TOKEN_TTL_DAYS');
    return new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
  }
}

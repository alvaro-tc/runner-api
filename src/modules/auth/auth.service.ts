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
import { GoogleVerifier } from './social/google.verifier';
import { AppleVerifier } from './social/apple.verifier';
import { AppleClient } from './social/apple.client';
import type {
  AppleLoginDto,
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
  /// `false` en las cuentas que entraron con Google o Apple y nunca pusieron
  /// una. La app lo necesita para no ofrecer "cambiar contrasena" a quien no
  /// tiene.
  hasPassword: boolean;
  /// La cuenta esta vinculada a Sign in with Apple. La app lo muestra en
  /// Ajustes —"Usando Iniciar sesion con Apple"—, como pide la guia de Apple.
  hasApple: boolean;
}

/** El dominio de "Ocultar mi correo": esa parte local es aleatoria, no un nombre. */
const RELAY_DE_APPLE = '@privaterelay.appleid.com';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    private readonly config: AppConfigService,
    private readonly google: GoogleVerifier,
    private readonly apple: AppleVerifier,
    private readonly appleClient: AppleClient,
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

    // El alta solo pide credenciales: pedir el nombre en el registro es lo que
    // hace abandonar el formulario. Si no viene, entra uno provisional (la parte
    // local del email, o la CI) y el usuario pone el real en su perfil.
    // Perfil y preferencias nacen con el usuario: asi ningun endpoint tiene que
    // preguntarse si existen, y `onboardingSeenAt` empieza en null de verdad.
    const user = await this.prisma.user.create({
      data: {
        email: dto.email ?? null,
        ci,
        passwordHash,
        name: dto.name || dto.email?.split('@')[0] || (ci as string),
        profile: {
          create: {
            birthDate: dto.birthDate ? new Date(dto.birthDate) : null,
            ...(dto.gender ? { gender: dto.gender } : {}),
          },
        },
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

  /**
   * Entra con Google, creando la cuenta si es la primera vez.
   *
   * **La identidad es el email verificado por Google**, no un id de proveedor
   * guardado aparte: el email ya es unico en `users` y ya es una credencial de
   * acceso, asi que una tabla `SocialAccount` no anadiria nada que la fila del
   * usuario no diga. Vincular por email es seguro **solo** porque
   * `GoogleVerifier` rechaza los correos sin verificar; sin esa condicion esto
   * seria la forma de entrar en la cuenta de otro.
   *
   * La cuenta nueva nace con `passwordHash` nulo: no tiene contrasena y lo
   * dice. `login()` ya lo trata como fallo —verifica contra un hash ficticio
   * para no delatar por tiempo que la cuenta no tiene clave— y `hasPassword`
   * deja que la app sepa si tiene sentido pedirsela. Quien quiera ademas una
   * contrasena normal la pone por "olvide mi contrasena".
   */
  async loginWithGoogle(idToken: string, device: DeviceInfo) {
    const { email, name } = await this.google.verify(idToken);

    const existente = await this.prisma.user.findUnique({
      where: { email },
      include: { preferences: true },
    });

    // Cuenta borrada: el email sigue ocupado hasta la purga diferida, asi que
    // ni se reutiliza la fila ni se crea otra. Mismo error opaco que en login.
    if (existente?.deletedAt) {
      throw new AppException(
        ErrorCode.INVALID_CREDENTIALS,
        'Email o contrasena incorrectos',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const user =
      existente ??
      (await this.prisma.user.create({
        data: {
          email,
          passwordHash: null,
          name: name || email.split('@')[0] || email,
          // Nadie le impuso una contrasena: no hay nada que forzarle a cambiar.
          mustChangePassword: false,
          profile: { create: {} },
          preferences: { create: {} },
        },
        include: { preferences: true },
      }));

    const pair = await this.tokens.issueForNewSession(user.id, user.role, device);

    return {
      ...pair,
      user: this.toPublic(user, user.preferences?.onboardingSeenAt ?? null),
    };
  }

  /**
   * Entra con Apple, creando la cuenta si es la primera vez.
   *
   * **La identidad es el `sub` de Apple**, no el email: con "Ocultar mi
   * correo" el email es un relay que no coincide con nada, y el usuario puede
   * dejar de compartirlo cuando quiera. Por eso, a diferencia de Google, aqui
   * si se guarda un identificador de proveedor.
   *
   * El orden de busqueda es el que propone Apple para no duplicar cuentas:
   * primero por `sub`; si no, por el email **verificado** que compartio —si es
   * el real y ya tenia cuenta con el, se vincula a esa—; y solo si no hay
   * ninguna, se crea. Un relay nunca coincide, asi que con correo oculto
   * siempre es cuenta nueva.
   *
   * El nombre llega solo la primera vez y la cuenta se crea con el: Apple pide
   * no volver a preguntar lo que ya se compartio. Sin nombre, se usa el del
   * correo; con un relay —parte local aleatoria— uno neutro que el usuario
   * cambia en su perfil cuando quiera.
   *
   * Cada login canjea el codigo de autorizacion por un refresh token. No da
   * acceso a nada: es lo que permite **revocar** al borrar la cuenta, que es
   * requisito de Apple. Si el canje falla se entra igual y queda en el log.
   */
  async loginWithApple(dto: AppleLoginDto, device: DeviceInfo) {
    const apple = await this.apple.verifyIdentityToken(dto.identityToken, dto.nonce);

    let user = await this.prisma.user.findUnique({
      where: { appleSub: apple.sub },
      include: { preferences: true },
    });

    // Vincular por correo solo con uno verificado por Apple. Es la misma regla
    // que con Google: sin ella, entrar en la cuenta de otro seria tan facil
    // como declarar su email.
    if (!user && apple.email && apple.emailVerified) {
      const porEmail = await this.prisma.user.findUnique({
        where: { email: apple.email },
        include: { preferences: true },
      });
      // Otra Apple Account ya ocupa esa cuenta: no se le cambia el dueno.
      if (porEmail?.appleSub && porEmail.appleSub !== apple.sub) {
        throw new AppException(
          ErrorCode.EMAIL_ALREADY_REGISTERED,
          'Esa cuenta ya esta vinculada a otra Apple Account',
          HttpStatus.CONFLICT,
        );
      }
      user = porEmail;
    }

    // Cuenta borrada: el email sigue ocupado hasta la purga diferida, asi que
    // ni se reutiliza la fila ni se crea otra. Mismo error opaco que en login.
    if (user?.deletedAt) {
      throw new AppException(
        ErrorCode.INVALID_CREDENTIALS,
        'Email o contrasena incorrectos',
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (!user) {
      // Se piden nombre y correo en la autorizacion, asi que siempre llega uno:
      // el real o el relay. Sin ninguno la cuenta no tendria por donde
      // recuperarse ni con que identificarse fuera de Apple.
      if (!apple.email) {
        throw new AppException(
          ErrorCode.INVALID_CREDENTIALS,
          'Apple no compartio un correo para crear la cuenta',
          HttpStatus.UNAUTHORIZED,
        );
      }

      user = await this.prisma.user.create({
        data: {
          email: apple.email,
          appleSub: apple.sub,
          passwordHash: null,
          name: this.nombreDeApple(dto, apple.email),
          // Nadie le impuso una contrasena: no hay nada que forzarle a cambiar.
          mustChangePassword: false,
          profile: { create: {} },
          preferences: { create: {} },
        },
        include: { preferences: true },
      });
    }

    const refreshToken = await this.appleClient.exchangeCode(dto.authorizationCode, apple.clientId);

    // Vincula (si llego por email) y guarda el token mas reciente. Uno nuevo
    // sustituye al anterior: el viejo pudo morir con un cambio de contrasena
    // de la Apple Account.
    user = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        appleSub: apple.sub,
        ...(refreshToken ? { appleRefreshToken: refreshToken, appleClientId: apple.clientId } : {}),
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
   * Las notificaciones servidor a servidor de Apple: cambios que el usuario
   * hace desde los ajustes de su Apple Account, fuera de la app.
   *
   * - `consent-revoked`: dejo de usar Sign in with Apple con CamRun. Sus
   *   credenciales de Apple ya no valen, asi que se cierran sus sesiones —en
   *   el telefono, la app ademas lo ve con `getCredentialState`— y se olvida
   *   el token, que Apple ya invalido. El `sub` se queda: si vuelve a entrar con
   *   Apple, es la misma persona y recupera su cuenta.
   * - `account-deleted`: borro su Apple Account. Ese `sub` no volvera nunca, asi
   *   que ademas se desvincula. La cuenta de CamRun no se borra sola: puede
   *   tener contrasena, carreras pagadas o resultados; si quiere borrarla, lo
   *   hace desde la app o la web.
   * - `email-disabled` / `email-enabled`: cambio el reenvio de su correo
   *   oculto. Solo se registra: el unico correo que manda CamRun es el de
   *   recuperar contrasena, y lo pide el propio usuario.
   */
  async handleAppleNotification(payload: string): Promise<{ ok: true }> {
    const evento = await this.apple.verifyNotification(payload);

    const user = await this.prisma.user.findUnique({
      where: { appleSub: evento.sub },
      select: { id: true },
    });

    // Un `sub` que no conocemos —cuenta ya borrada, o de otro entorno— no es un
    // error: Apple no tiene por que saberlo. Se responde 200 para que no
    // reintente.
    if (!user) {
      this.logger.log(`Notificacion de Apple (${evento.type}) para un usuario que no existe`);
      return { ok: true };
    }

    // `account-delete` es el nombre anterior del evento en la documentacion.
    switch (evento.type) {
      case 'consent-revoked':
      case 'account-deleted':
      case 'account-delete': {
        const desvincular = evento.type !== 'consent-revoked';
        await this.prisma.$transaction([
          this.prisma.user.update({
            where: { id: user.id },
            data: {
              appleRefreshToken: null,
              appleClientId: null,
              ...(desvincular ? { appleSub: null } : {}),
            },
          }),
          this.prisma.authSession.updateMany({
            where: { userId: user.id, revokedAt: null },
            data: { revokedAt: new Date() },
          }),
        ]);
        this.logger.log(`Apple: ${evento.type} para el usuario ${user.id}; sesiones cerradas`);
        break;
      }
      case 'email-disabled':
      case 'email-enabled':
        this.logger.log(`Apple: ${evento.type} para el usuario ${user.id}`);
        break;
      default:
        this.logger.warn(`Notificacion de Apple desconocida: ${evento.type}`);
    }

    return { ok: true };
  }

  /** El nombre para una cuenta nueva de Apple. */
  private nombreDeApple(dto: AppleLoginDto, email: string): string {
    const completo = [dto.givenName, dto.familyName]
      .map((parte) => parte?.trim())
      .filter(Boolean)
      .join(' ');
    if (completo) return completo;
    if (email.toLowerCase().endsWith(RELAY_DE_APPLE)) return 'Corredor';
    return email.split('@')[0] || 'Corredor';
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
      passwordHash: string | null;
      appleSub: string | null;
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
      hasPassword: user.passwordHash !== null,
      hasApple: user.appleSub !== null,
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

    // Cuenta de Google o Apple sin contrasena: no hay "actual" que comprobar.
    // Decirlo en claro no filtra nada —quien pregunta ya esta autenticado como
    // el— y evita el callejon de "la contrasena actual no es correcta".
    if (!user.passwordHash) {
      throw new AppException(
        ErrorCode.NO_PASSWORD_SET,
        'Esta cuenta entra con Google o Apple. Usa "olvide mi contrasena" para ponerle una.',
        HttpStatus.CONFLICT,
      );
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

import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { PrismaService } from '../../database/prisma.service';
import { TokenService } from '../auth/token.service';
import { RegistrationStatus, UserRole } from '../../../generated/prisma/enums';
import type { EstadoDeMaraton, LlegadaEnVivo, PosicionEnVivo } from './live-state';

/** Namespace del seguimiento en vivo. Separado del resto por si algun dia lo hay. */
export const NAMESPACE_LIVE = '/live';

/** Nombre de la sala de una maraton. Un solo sitio que lo decide. */
export function salaDeMaraton(marathonId: string): string {
  return `marathon:${marathonId}`;
}

/**
 * Sala personal de un usuario. Se entra en el handshake y no se pide.
 *
 * Existe porque hay avisos que llegan a alguien que **no esta en ninguna sala
 * de maraton**: quien espera que le validen el comprobante todavia no esta
 * inscrito, asi que no hay carrera de la que colgarle la noticia.
 */
export function salaDeUsuario(userId: string): string {
  return `user:${userId}`;
}

function salaDeEstado(marathonId: string): string {
  return `marathon:${marathonId}:state`;
}

function salaDeCorredor(marathonId: string, bib: string): string {
  return `marathon:${marathonId}:runner:${bib}`;
}

interface SocketDeEspectador extends Socket {
  userId?: string;
  authenticated?: Promise<void>;
  role?: UserRole;
  runnerRooms?: Map<string, string>;
  subscriptions?: Map<string, number>;
  subscriptionVersion?: number;
}

/**
 * Seguimiento en vivo de una maraton.
 *
 * **Es la base, no la funcion completa.** Lo que hay: namespace, salas por
 * maraton, autenticacion de la conexion y el evento `runner:position` con el
 * throttling puesto. Lo que falta —autorizacion fina de espectadores, opt-in de
 * privacidad del corredor, clustering en el mapa— esta listado en
 * `docs/tracking.md` con lo que costaria cada cosa.
 *
 * Se pide **token en el handshake**. Podria abrirse a cualquiera, pero las
 * posiciones de una persona en tiempo real son de las cosas mas sensibles que
 * guarda esta API, y un namespace publico es de esas puertas que nadie se
 * acuerda de cerrar despues.
 */
@WebSocketGateway({ namespace: NAMESPACE_LIVE })
export class LiveGateway implements OnGatewayConnection {
  private readonly logger = new Logger(LiveGateway.name);

  @WebSocketServer()
  private server?: Server;

  constructor(
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Autentica al conectar y no en cada mensaje.
   *
   * Un socket vive minutos u horas: verificar el JWT en cada evento seria
   * verificarlo miles de veces por el mismo cliente. La contrapartida —que el
   * token caduque con el socket abierto— es aceptable aqui: el peor caso es un
   * espectador viendo dorsales quince minutos de mas.
   */
  async handleConnection(socket: SocketDeEspectador): Promise<void> {
    socket.authenticated = this.authenticate(socket);
    await socket.authenticated;
  }

  private async authenticate(socket: SocketDeEspectador): Promise<void> {
    const token = extraerToken(socket);

    if (!token) {
      socket.disconnect(true);
      return;
    }

    try {
      const payload = await this.tokens.verifyAccessToken(token);
      socket.userId = payload.sub;
      socket.role = payload.role;
      // Su sala personal, sin pedirla: es la unica forma de avisar a alguien que
      // todavia no esta inscrito en nada.
      await socket.join(salaDeUsuario(payload.sub));
    } catch {
      // Sin mensaje de error: quien no tiene token valido no merece saber si
      // fallo por caducado o por invalido.
      socket.disconnect(true);
    }
  }

  /**
   * Empezar a ver una maraton.
   *
   * Se comprueba que exista y este publicada; sin eso, cualquiera podria
   * suscribirse a `marathon:<lo que sea>` y descubrir por el trafico que hay
   * algo detras.
   *
   * **Salvo para quien la gestiona.** El panel del admin y el del organizador
   * miran el mismo mapa de una carrera que todavia no se publico —una prueba,
   * una que se prepara para manana— y con la regla general ese mapa se queda
   * mudo: la foto por REST se ve y no vuelve a moverse nunca, que es la peor
   * forma de fallar porque parece que funciona.
   */
  @SubscribeMessage('spectate')
  async spectate(
    @ConnectedSocket() socket: SocketDeEspectador,
    @MessageBody() body: { marathonId?: string; positions?: boolean },
  ): Promise<{ ok: boolean; room?: string; error?: string }> {
    const marathonId = typeof body?.marathonId === 'string' ? body.marathonId : '';
    const subscription = `${marathonId}:${body?.positions === false ? 'runner' : 'map'}`;
    socket.subscriptions ??= new Map();
    const version = (socket.subscriptionVersion ?? 0) + 1;
    socket.subscriptionVersion = version;
    socket.subscriptions.set(subscription, version);
    const current = () => socket.subscriptions?.get(subscription) === version;
    await socket.authenticated;
    if (!socket.userId) return { ok: false, error: 'UNAUTHORIZED' };
    const gestiona = socket.role === UserRole.admin || socket.role === UserRole.organizer;

    const existe = await this.prisma.marathon.count({
      where: gestiona
        ? { id: marathonId }
        : { id: marathonId, publishedAt: { not: null, lte: new Date() } },
    });

    if (existe === 0) return { ok: false, error: 'MARATHON_NOT_FOUND' };

    // The runner needs race controls and their own lap updates, not every GPS
    // update in the event. Existing spectators keep the complete live feed.
    if (body.positions === false) {
      if (!socket.userId) return { ok: false, error: 'UNAUTHORIZED' };
      const registration = await this.prisma.registration.findFirst({
        where: {
          marathonId,
          userId: socket.userId,
          status: RegistrationStatus.confirmed,
          deletedAt: null,
        },
        select: { bibNumber: true },
      });
      if (!registration) return { ok: false, error: 'REGISTRATION_NOT_FOUND' };
      if (!current()) return { ok: false, error: 'SUBSCRIPTION_CANCELLED' };
      const room = salaDeEstado(marathonId);
      await socket.join(room);
      if (!current()) {
        if (!socket.subscriptions.has(subscription)) await socket.leave(room);
        return { ok: false, error: 'SUBSCRIPTION_CANCELLED' };
      }
      if (registration.bibNumber) {
        const ownRoom = salaDeCorredor(marathonId, registration.bibNumber);
        const previous = socket.runnerRooms?.get(marathonId);
        if (previous && previous !== ownRoom) await socket.leave(previous);
        await socket.join(ownRoom);
        socket.runnerRooms ??= new Map();
        socket.runnerRooms.set(marathonId, ownRoom);
      }
      if (!current()) {
        if (!socket.subscriptions.has(subscription)) {
          await socket.leave(room);
          const ownRoom = socket.runnerRooms?.get(marathonId);
          if (ownRoom) await socket.leave(ownRoom);
          socket.runnerRooms?.delete(marathonId);
        }
        return { ok: false, error: 'SUBSCRIPTION_CANCELLED' };
      }
      return { ok: true, room };
    }

    if (!current()) return { ok: false, error: 'SUBSCRIPTION_CANCELLED' };
    const room = salaDeMaraton(marathonId);
    await socket.join(room);
    if (!current()) {
      if (!socket.subscriptions.has(subscription)) await socket.leave(room);
      return { ok: false, error: 'SUBSCRIPTION_CANCELLED' };
    }
    return { ok: true, room };
  }

  @SubscribeMessage('leave')
  async leave(
    @ConnectedSocket() socket: SocketDeEspectador,
    @MessageBody() body: { marathonId?: string; positions?: boolean },
  ): Promise<{ ok: boolean }> {
    const id = String(body?.marathonId ?? '');
    if (body?.positions !== false) socket.subscriptions?.delete(`${id}:map`);
    if (body?.positions !== true) socket.subscriptions?.delete(`${id}:runner`);
    if (body?.positions !== false) await socket.leave(salaDeMaraton(id));
    if (body?.positions !== true) {
      await socket.leave(salaDeEstado(id));
      const ownRoom = socket.runnerRooms?.get(id);
      if (ownRoom) await socket.leave(ownRoom);
      socket.runnerRooms?.delete(id);
    }
    return { ok: true };
  }

  /**
   * Publica una posicion a los espectadores de esa maraton.
   *
   * Emitir a una sala vacia no cuesta nada y no falla, asi que no se comprueba
   * si hay alguien mirando: la alternativa —preguntar por el tamano de la sala
   * en cada punto— es una consulta al adapter de Redis por cada corredor y cada
   * cinco segundos, para ahorrar un no-op.
   */
  emitirPosicion(marathonId: string, payload: PosicionEnVivo): void {
    if (!this.server) {
      // Pasa en tests que montan el modulo sin servidor HTTP. No es un fallo:
      // la ingesta tiene que seguir funcionando aunque no haya nadie escuchando.
      this.logger.debug('Gateway sin servidor: no se publica la posicion');
      return;
    }

    const rooms = [salaDeMaraton(marathonId)];
    if (payload.bib) rooms.push(salaDeCorredor(marathonId, payload.bib));
    this.server.to(rooms).emit('runner:position', payload);
  }

  /**
   * Avisa a la sala de que la carrera arranco o termino.
   *
   * Lo escuchan los dos lados por el mismo canal: el panel, para pintar el
   * estado, y el movil del corredor, que es lo que hace que la pantalla de
   * carrera se abra sola. Va por la sala de la maraton y no por un canal propio
   * porque quien mira esa maraton es exactamente quien tiene que enterarse.
   *
   * Ademas va a la sala personal de cada inscrito: el corredor que tiene la app
   * en la pantalla de inicio no pidio ver esta maraton, y aun asi la
   * preparacion y la largada tienen que abrirle la pantalla de carrera. Socket
   * .IO entrega **una sola vez** a quien esta en las dos salas.
   */
  emitirEstado(
    marathonId: string,
    estado: EstadoDeMaraton,
    inscritos: readonly string[] = [],
  ): void {
    if (!this.server) {
      this.logger.debug('Gateway sin servidor: no se publica el estado');
      return;
    }

    const salas = [
      salaDeMaraton(marathonId),
      salaDeEstado(marathonId),
      ...inscritos.map(salaDeUsuario),
    ];
    this.server.to(salas).emit('marathon:state', estado);
  }

  /**
   * Avisa al dueño de una inscripcion de que algo cambio en ella.
   *
   * **Sin datos a proposito**: solo el id. Quien lo recibe vuelve a pedir sus
   * inscripciones por REST, que es la fuente unica; mandar aqui el estado seria
   * una segunda version de la verdad que puede llegar desordenada.
   */
  emitirInscripcion(userId: string, registrationId: string): void {
    if (!this.server) {
      this.logger.debug('Gateway sin servidor: no se publica el cambio de inscripcion');
      return;
    }

    this.server.to(salaDeUsuario(userId)).emit('registration:state', { registrationId });
  }

  /**
   * Una notificacion nueva en la bandeja de este usuario. Aqui si viaja entera:
   * ya esta guardada, no hay otra version que pueda llegar desordenada, y la
   * app la necesita para pintar el aviso sin otra ida y vuelta.
   */
  emitirNotificacion(userId: string, notificacion: object): void {
    if (!this.server) return;
    this.server.to(salaDeUsuario(userId)).emit('notification:new', notificacion);
  }

  /**
   * Avisa de que un corredor cruzo la meta.
   *
   * Va por la misma sala que las posiciones y con la misma regla: solo el
   * dorsal. Lo escuchan el panel —para tachar al que ya llego— y el movil del
   * propio corredor, que se reconoce por su dorsal y cierra su carrera. Un
   * canal privado por corredor obligaria a que el servidor supiera que socket
   * es de quien, que es justo lo que este namespace evita.
   */
  emitirLlegada(marathonId: string, llegada: LlegadaEnVivo): void {
    if (!this.server) {
      this.logger.debug('Gateway sin servidor: no se publica la llegada');
      return;
    }

    const rooms = [salaDeMaraton(marathonId)];
    if (llegada.bib) rooms.push(salaDeCorredor(marathonId, llegada.bib));
    this.server.to(rooms).emit('runner:finish', llegada);
  }
}

/**
 * El token viaja en `auth.token` del handshake, no en la query.
 *
 * La query acaba en los logs de acceso del proxy; `auth` va en el payload del
 * handshake y no. Se acepta la query igualmente porque hay clientes que no
 * pueden mandar `auth`, pero el orden dice cual es el bueno.
 */
function extraerToken(socket: Socket): string | undefined {
  const { auth, query } = socket.handshake;
  const deAuth = (auth as { token?: unknown }).token;

  if (typeof deAuth === 'string' && deAuth !== '') return deAuth;

  const deQuery = query.token;
  return typeof deQuery === 'string' && deQuery !== '' ? deQuery : undefined;
}

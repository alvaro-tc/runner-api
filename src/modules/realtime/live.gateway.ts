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
import type { EstadoDeMaraton, LlegadaEnVivo, PosicionEnVivo } from './live-state';

/** Namespace del seguimiento en vivo. Separado del resto por si algun dia lo hay. */
export const NAMESPACE_LIVE = '/live';

/** Nombre de la sala de una maraton. Un solo sitio que lo decide. */
export function salaDeMaraton(marathonId: string): string {
  return `marathon:${marathonId}`;
}

interface SocketDeEspectador extends Socket {
  userId?: string;
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
    const token = extraerToken(socket);

    if (!token) {
      socket.disconnect(true);
      return;
    }

    try {
      const payload = await this.tokens.verifyAccessToken(token);
      socket.userId = payload.sub;
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
   */
  @SubscribeMessage('spectate')
  async spectate(
    @ConnectedSocket() socket: SocketDeEspectador,
    @MessageBody() body: { marathonId?: string },
  ): Promise<{ ok: boolean; room?: string; error?: string }> {
    const marathonId = typeof body?.marathonId === 'string' ? body.marathonId : '';

    const existe = await this.prisma.marathon.count({
      where: { id: marathonId, publishedAt: { not: null, lte: new Date() } },
    });

    if (existe === 0) return { ok: false, error: 'MARATHON_NOT_FOUND' };

    const room = salaDeMaraton(marathonId);
    await socket.join(room);

    return { ok: true, room };
  }

  @SubscribeMessage('leave')
  async leave(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { marathonId?: string },
  ): Promise<{ ok: boolean }> {
    await socket.leave(salaDeMaraton(String(body?.marathonId ?? '')));
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

    this.server.to(salaDeMaraton(marathonId)).emit('runner:position', payload);
  }

  /**
   * Avisa a la sala de que la carrera arranco o termino.
   *
   * Lo escuchan los dos lados por el mismo canal: el panel, para pintar el
   * estado, y el movil del corredor, que es lo que hace que la pantalla de
   * carrera se abra sola. Va por la sala de la maraton y no por un canal propio
   * porque quien mira esa maraton es exactamente quien tiene que enterarse.
   */
  emitirEstado(marathonId: string, estado: EstadoDeMaraton): void {
    if (!this.server) {
      this.logger.debug('Gateway sin servidor: no se publica el estado');
      return;
    }

    this.server.to(salaDeMaraton(marathonId)).emit('marathon:state', estado);
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

    this.server.to(salaDeMaraton(marathonId)).emit('runner:finish', llegada);
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

import { Logger, type INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { ServerOptions } from 'socket.io';
import type { AppConfigService } from '../../config/app-config.service';

/**
 * Socket.IO con el adapter de Redis.
 *
 * Sin el, cada instancia de la API solo alcanza a los sockets conectados **a
 * ella**: dos procesos detras de un balanceador y la mitad de los espectadores
 * de una maraton no ve nada, sin ningun error en ningun log. El adapter reparte
 * cada emision por pub/sub y las salas pasan a ser globales.
 *
 * Hoy corre una sola instancia y el adapter no hace falta. Se pone igual porque
 * es la pieza que permite anadir la segunda sin cambiar una linea de la logica —
 * y porque el dia que haga falta sera durante una carrera, no antes.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private clients: Redis[] = [];

  constructor(
    app: INestApplicationContext,
    private readonly config: AppConfigService,
  ) {
    super(app);
  }

  /**
   * Conecta pub y sub. Devuelve `false` si Redis no responde.
   *
   * Que no haya Redis no puede tumbar la API entera: el seguimiento en vivo es
   * la unica cosa que se queda coja, y una carrera sin mapa de espectadores
   * sigue siendo una carrera. Se avisa fuerte en el log y se sigue con el
   * adapter en memoria.
   */
  async connect(): Promise<boolean> {
    // El cliente de suscripcion no puede ejecutar comandos normales: por eso
    // son dos conexiones y no una. Lo pide el propio adapter.
    const pub = new Redis(this.config.get('REDIS_URL'), {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    const sub = pub.duplicate();

    try {
      await Promise.all([pub.connect(), sub.connect()]);
    } catch (error) {
      this.logger.error(
        `Redis no responde (${(error as Error).message}). El seguimiento en vivo funcionara solo dentro de esta instancia.`,
      );
      pub.disconnect();
      sub.disconnect();
      return false;
    }

    this.clients = [pub, sub];
    this.adapterConstructor = createAdapter(pub, sub);
    this.logger.log('Socket.IO conectado a Redis');

    return true;
  }

  override createIOServer(port: number, options?: ServerOptions): unknown {
    const origins = this.config.corsOrigins;

    const server = super.createIOServer(port, {
      ...options,
      // Los WebSockets no pasan por el CORS de Express: hay que repetirlo aqui
      // o el navegador tumba el handshake con un error que no dice nada.
      cors: { origin: origins.includes('*') ? true : origins, credentials: true },
    }) as { adapter: (a: unknown) => void };

    if (this.adapterConstructor) server.adapter(this.adapterConstructor);

    return server;
  }

  override async close(server: unknown): Promise<void> {
    await super.close(server as never);
    for (const cliente of this.clients) cliente.disconnect();
    this.clients = [];
  }
}

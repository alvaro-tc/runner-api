import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../database/prisma.service';
import { StorageService } from '../modules/storage/storage.service';

export type DependencyStatus = 'up' | 'down';

export interface ReadinessReport {
  status: 'ok' | 'error';
  checks: Record<string, { status: DependencyStatus; error?: string }>;
}

/**
 * Comprobacion de dependencias para `/ready`.
 *
 * Postgres se comprueba con el pool que ya tiene `PrismaService`; Redis con un
 * `ping`. Sin @nestjs/terminus: el formato de respuesta ya lo da el sobre
 * `{ data, meta }` propio.
 */
@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly logger = new Logger(HealthService.name);
  private redis?: Redis;

  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async check(): Promise<ReadinessReport> {
    const [database, redis, uploads] = await Promise.all([
      this.checkPostgres(),
      this.checkRedis(),
      this.checkUploads(),
    ]);
    const checks = { database, redis, uploads };
    // `uploads` informa pero NO tumba el readiness: sin disco de subidas la API
    // sigue atendiendo inscripciones y pagos, y bloquear un despliegue por un
    // permiso de directorio seria peor que el fallo que reporta. Que este a la
    // vista es lo que importa: un `uploads: down` explica de un vistazo por que
    // fallan TODAS las subidas de imagen.
    const status = database.status === 'up' && redis.status === 'up' ? 'ok' : 'error';
    return { status, checks };
  }

  /**
   * Escribe y borra un fichero de prueba en `UPLOADS_DIR`.
   *
   * Comprobar solo que el directorio existe no sirve: el fallo tipico es que
   * exista pero sea de otro usuario (creado como root al copiar imagenes a
   * mano), y entonces cada subida responde 500 sin que nada mas lo delate.
   */
  private async checkUploads(): Promise<{ status: DependencyStatus; error?: string }> {
    try {
      await this.storage.assertWritable();
      return { status: 'up' };
    } catch (err) {
      this.logger.warn(`Directorio de subidas no escribible: ${asMessage(err)}`);
      // El detalle (ruta y errno) queda en el log: `/ready` es publico.
      return { status: 'down', error: 'El directorio de subidas no admite escrituras' };
    }
  }

  private async checkPostgres(): Promise<{ status: DependencyStatus; error?: string }> {
    try {
      await this.prisma.ping();
      return { status: 'up' };
    } catch (err) {
      this.logger.warn(`Postgres no responde: ${asMessage(err)}`);
      return { status: 'down', error: asMessage(err) };
    }
  }

  private async checkRedis(): Promise<{ status: DependencyStatus; error?: string }> {
    try {
      this.redis ??= new Redis(this.config.get('REDIS_URL'), {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        // Sin esto ioredis reintenta para siempre y el healthcheck se cuelga.
        retryStrategy: () => null,
      });
      if (this.redis.status !== 'ready') await this.redis.connect();
      await this.redis.ping();
      return { status: 'up' };
    } catch (err) {
      this.logger.warn(`Redis no responde: ${asMessage(err)}`);
      // Una conexion fallida queda inservible: se descarta para reintentar limpio.
      this.redis?.disconnect();
      this.redis = undefined;
      return { status: 'down', error: asMessage(err) };
    }
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../database/prisma.service';

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
  ) {}

  async check(): Promise<ReadinessReport> {
    const [database, redis] = await Promise.all([this.checkPostgres(), this.checkRedis()]);
    const checks = { database, redis };
    const status = Object.values(checks).every((c) => c.status === 'up') ? 'ok' : 'error';
    return { status, checks };
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

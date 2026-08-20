import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { AppConfigService } from '../config/app-config.service';

/**
 * Cliente de Prisma como provider de Nest.
 *
 * Es la unica puerta a la base de datos: ningun modulo instancia su propio
 * `PrismaClient`, porque cada instancia abre su propio pool de conexiones y
 * agotar el pool de Postgres es una forma tonta de caerse.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfigService) {
    // Prisma 7 se conecta siempre a traves de un driver adapter; ya no acepta
    // una URL suelta. `PrismaPg` gestiona el pool de `pg` por debajo.
    super({
      adapter: new PrismaPg({ connectionString: config.get('DATABASE_URL') }),
      log: config.isDevelopment ? ['warn', 'error'] : ['error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Conectado a PostgreSQL');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Un `SELECT 1`, para que `/ready` sepa si la base responde. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }

  /** Meses cuya particion ya se comprobo en este proceso. Ver abajo. */
  private readonly particionesCreadas = new Set<string>();

  /**
   * Se asegura de que exista la particion de cada fecha dada.
   *
   * Recuerda los meses ya comprobados: la ingesta llama a esto en **cada lote**
   * —varias veces por minuto y por corredor— y sin el cache seria una consulta
   * extra por lote para crear una particion que ya existe. Si el proceso se
   * reinicia, el cache se vacia y vuelve a preguntar una vez por mes.
   */
  async ensurePositionsPartitions(fechas: Iterable<Date>): Promise<void> {
    for (const fecha of fechas) {
      const mes = fecha.toISOString().slice(0, 7);
      if (this.particionesCreadas.has(mes)) continue;

      await this.ensurePositionsPartition(new Date(`${mes}-01T00:00:00.000Z`));
      this.particionesCreadas.add(mes);
    }
  }

  /**
   * Crea la particion mensual de `positions` que contiene la fecha dada.
   *
   * Idempotente. La llama el job mensual (Fase 11); tenerla aqui evita que ese
   * job tenga que conocer el SQL.
   */
  async ensurePositionsPartition(date: Date): Promise<string> {
    const rows = await this.$queryRaw<
      { create_positions_partition: string }[]
    >`SELECT create_positions_partition(${date}::date)`;
    return rows[0]?.create_positions_partition ?? 'sin resultado';
  }
}

import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../modules/auth/decorators/public.decorator';
import { HealthService, type ReadinessReport } from './health.service';

@ApiTags('health')
@Controller()
// Los consume la infraestructura, sin token y varias veces por minuto: quedan
// fuera del guard global de JWT y fuera del rate limit.
@Public()
@SkipThrottle()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Liveness: "el proceso esta vivo". No toca dependencias a proposito, para
   * que systemd no reinicie la API cuando lo que se cayo fue Postgres.
   */
  @Get('health')
  @ApiOperation({ summary: 'Liveness: el proceso responde' })
  liveness(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  /** Readiness: "puedo atender trafico". Verifica Postgres y Redis. */
  @Get('ready')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Readiness: dependencias disponibles' })
  async readiness(): Promise<ReadinessReport> {
    const report = await this.health.check();
    if (report.status === 'error') {
      throw new ServiceUnavailableException({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Alguna dependencia no esta disponible',
        details: [report.checks],
      });
    }
    return report;
  }
}

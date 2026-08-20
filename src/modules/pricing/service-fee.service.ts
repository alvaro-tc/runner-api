import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { ServiceFeeScope } from '../../../generated/prisma/enums';
import type { ConfigDeFee } from './service-fee';

@Injectable()
export class ServiceFeeConfigService {
  private readonly logger = new Logger(ServiceFeeConfigService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Que config de cargo por servicio aplica a una maraton.
   *
   * El orden es: **override de la maraton → config global → nada**. Y el
   * override manda aunque venga apagado: una maraton con
   * `serviceFeeConfigId` apuntando a una config con `enabled = false` significa
   * "esta carrera no cobra cargo", no "usa la global". Si el override apagado
   * cayera de vuelta a la global, no habria forma de eximir a una sola carrera
   * sin apagar el fee para todas.
   *
   * Devolver `null` (no hay ninguna config cargada) es equivalente a apagado.
   */
  async resolverPara(marathonId: string): Promise<ConfigDeFee | null> {
    const maraton = await this.prisma.marathon.findUnique({
      where: { id: marathonId },
      select: { serviceFeeConfig: true },
    });

    if (maraton?.serviceFeeConfig) return maraton.serviceFeeConfig;

    return this.global();
  }

  /**
   * La config global. Se lee en cada cotizacion a proposito: es una fila unica
   * que Postgres devuelve del cache de pagina, y cachearla en memoria haria que
   * apagar el fee desde el panel tardara en verse en cada instancia de la API.
   * Ese retardo, en el numero que decide cuanto paga la gente, no vale el
   * ahorro.
   */
  async global(): Promise<ConfigDeFee | null> {
    const config = await this.prisma.serviceFeeConfig.findFirst({
      where: { scope: ServiceFeeScope.global },
      orderBy: { createdAt: 'asc' },
    });

    if (!config) {
      // No es un error: sin config, no hay cargo. Pero si el seed corrio, la
      // fila deberia existir, asi que conviene que quede en el log.
      this.logger.debug('No hay config global de service fee; se cotiza sin cargo');
    }

    return config;
  }
}

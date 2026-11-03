import { Body, Controller, Get, HttpStatus, Param, Put, UseInterceptors } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Permiso } from '../auth/decorators/roles.decorator';
import { USUARIO_API } from '../auth/permisos';
import { PasarelaClient } from '../payments/pasarela/pasarela.client';
import { AuditoriaInterceptor } from './auditoria.interceptor';

class PaymentApiDto {
  @IsBoolean()
  enabled!: boolean;
}

class ValidatorDto {
  /** `api-pasarela`, el id de un usuario con `cobros.validar`, o null (cualquiera). */
  @IsOptional()
  @IsString()
  userId?: string | null;
}

/**
 * Administrador de plataforma: enciende la API de pagos y asigna quien valida
 * los cobros de cada carrera. Cada cambio queda en la auditoria (interceptor).
 */
@ApiTags('admin')
@ApiBearerAuth('access-token')
@Permiso('plataforma.gestionar')
@Throttle({ corto: { limit: 60, ttl: 60_000 } })
@UseInterceptors(AuditoriaInterceptor)
@Controller('admin/plataforma')
export class PlataformaController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pasarela: PasarelaClient,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Estado de la API de pagos, carreras con su validador y a quien se puede asignar' })
  async estado() {
    const [config, carreras, roles] = await Promise.all([
      this.prisma.platformConfig.findUnique({ where: { id: 1 } }),
      this.prisma.marathon.findMany({
        where: { rehearsalOfId: null },
        orderBy: { startsAt: 'desc' },
        select: {
          id: true,
          name: true,
          startsAt: true,
          paymentQrPayload: true,
          paymentValidator: { select: { id: true, name: true } },
        },
      }),
      this.prisma.role.findMany({ where: { permissions: { has: 'cobros.validar' } }, select: { key: true } }),
    ]);
    const candidatos = await this.prisma.user.findMany({
      where: { deletedAt: null, OR: [{ id: USUARIO_API }, { role: { in: roles.map((r) => r.key) } }] },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true, role: true },
    });

    return {
      paymentApiEnabled: config?.paymentApiEnabled ?? false,
      paymentApiConfigured: this.pasarela.configurada,
      apiUserId: USUARIO_API,
      candidates: candidatos,
      marathons: carreras.map((m) => ({
        id: m.id,
        name: m.name,
        startsAt: m.startsAt.toISOString(),
        hasDefaultQr: !!m.paymentQrPayload?.trim(),
        validator: m.paymentValidator,
      })),
    };
  }

  @Put('payment-api')
  @ApiOperation({ summary: 'Encender o apagar la API de pagos (apagada = todo vuelve a QR manual)' })
  async apiDePagos(@Body() dto: PaymentApiDto) {
    if (dto.enabled && !this.pasarela.configurada) {
      throw new AppException(
        ErrorCode.PASARELA_UNAVAILABLE,
        'Falta PASARELA_API_URL o PASARELA_API_KEY en el servidor',
        HttpStatus.CONFLICT,
      );
    }
    const c = await this.prisma.platformConfig.upsert({
      where: { id: 1 },
      create: { id: 1, paymentApiEnabled: dto.enabled },
      update: { paymentApiEnabled: dto.enabled },
    });
    return { paymentApiEnabled: c.paymentApiEnabled };
  }

  @Put('marathons/:id/validator')
  @ApiOperation({ summary: 'Asignar quien valida los cobros de una carrera (la API o un organizador)' })
  async asignar(@Param('id') id: string, @Body() dto: ValidatorDto) {
    const userId = dto.userId || null;
    if (userId && userId !== USUARIO_API) {
      const u = await this.prisma.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: { roleDef: { select: { permissions: true } } },
      });
      if (!u?.roleDef.permissions.includes('cobros.validar')) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Esa cuenta no tiene el permiso de validar cobros',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    const m = await this.prisma.marathon
      .update({
        where: { id },
        data: { paymentValidatorId: userId },
        select: { id: true, paymentValidator: { select: { id: true, name: true } } },
      })
      .catch(() => {
        throw new AppException(ErrorCode.NOT_FOUND, 'No se encontro esa carrera', HttpStatus.NOT_FOUND);
      });
    return { id: m.id, validator: m.paymentValidator };
  }
}

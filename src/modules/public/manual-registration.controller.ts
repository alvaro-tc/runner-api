import { Body, Controller, Param, Post, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditoriaInterceptor } from '../admin/auditoria.interceptor';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Permiso } from '../auth/decorators/roles.decorator';
import { ManualRegistrationDto } from './dto/public-registration.dto';
import { PublicRegistrationService } from './public-registration.service';

/** Inscripcion en fisico: el organizador cobro en efectivo y la carga desde el panel. */
@ApiTags('admin')
@ApiBearerAuth('access-token')
@Permiso('inscritas.manual')
@UseInterceptors(AuditoriaInterceptor)
@Controller('admin/marathons/:id/manual-registrations')
export class ManualRegistrationController {
  constructor(private readonly inscripciones: PublicRegistrationService) {}

  @Post()
  @ApiOperation({
    summary: 'Inscribir a quien pagó en efectivo',
    description:
      'Busca o crea la cuenta por CI (usuario y contraseña = CI), crea la inscripción y la deja ' +
      'confirmada con un cobro `cash` a nombre de quien llama. Toma cupo y dorsal como cualquier pago.',
  })
  inscribir(
    @CurrentUser('sub') organizadorId: string,
    @Param('id') marathonId: string,
    @Body() dto: ManualRegistrationDto,
  ) {
    return this.inscripciones.inscribirEnFisico(marathonId, dto, organizadorId);
  }
}

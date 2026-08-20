import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/dto/response-envelope';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { QuoteResponseDto } from '../pricing/dto/quote.dto';
import { RegistrationsService } from './registrations.service';
import {
  CreateRegistrationDto,
  ListRegistrationsQueryDto,
  RegistrationDto,
  UpdateCategoryExtrasDto,
} from './dto/registration.dto';

/**
 * Inscripcion en tres pasos. Todo exige token y todo es del usuario del token:
 * no hay ninguna ruta que reciba un `userId`.
 *
 * El campo `step` de la respuesta dice en que paso quedo, para que la app pueda
 * retomar el flujo donde se dejo despues de cerrarla.
 *
 * `POST /registrations/:id/checkout` vive en `PaymentsController`: el paso 3 es
 * un cobro, con su cabecera de idempotencia y su proveedor detras. Ponerlo aca
 * obligaria a que inscripciones dependa de pagos y pagos de inscripciones.
 */
@ApiTags('registrations')
@ApiBearerAuth('access-token')
@Controller('registrations')
export class RegistrationsController {
  constructor(private readonly registrations: RegistrationsService) {}

  @Get()
  @ApiOperation({
    summary: 'Mis inscripciones',
    description:
      'Con `?marathonId=` sirve para retomar un borrador cuando la app perdio el id. No ' +
      'recotiza: devuelve los totales guardados.',
  })
  @ApiResponse({ status: 200, type: [RegistrationDto] })
  list(@CurrentUser('sub') userId: string, @Query() query: ListRegistrationsQueryDto) {
    return this.registrations.listar(userId, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Paso 1: crea el borrador con los datos personales',
    description:
      'Si ya hay un borrador para esa maraton lo devuelve actualizado en vez de crear otro. Si ' +
      'ya hay una inscripcion confirmada responde ALREADY_REGISTERED.',
  })
  @ApiResponse({ status: 201, type: RegistrationDto })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'ALREADY_REGISTERED / MARATHON_FULL / REGISTRATION_CLOSED',
  })
  create(@CurrentUser('sub') userId: string, @Body() dto: CreateRegistrationDto) {
    return this.registrations.crear(userId, dto);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detalle de una inscripcion',
    description:
      'Un borrador se recotiza con los precios de hoy; una confirmada devuelve el desglose ' +
      'congelado, que es lo que se cobro.',
  })
  @ApiResponse({ status: 200, type: RegistrationDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'NOT_FOUND' })
  detail(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.registrations.obtener(userId, id);
  }

  @Patch(':id/category-extras')
  @ApiOperation({
    summary: 'Paso 2: categoria y adicionales',
    description:
      'La lista de `extras` reemplaza a la anterior: manda la seleccion completa, `[]` para ' +
      'dejarla sin extras. `categoryId: null` quita la categoria.',
  })
  @ApiResponse({ status: 200, type: RegistrationDto })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'REGISTRATION_NOT_EDITABLE / EXTRA_OUT_OF_STOCK',
  })
  updateCategoryExtras(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCategoryExtrasDto,
  ) {
    return this.registrations.actualizarCategoriaYExtras(userId, id, dto);
  }

  @Get(':id/quote')
  @ApiOperation({
    summary: 'Total en vivo de la inscripcion',
    description: 'Llamalo en cada cambio del paso 2. El total no se calcula nunca en el movil.',
  })
  @ApiResponse({ status: 200, type: QuoteResponseDto })
  quote(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.registrations.cotizar(userId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancela la inscripcion y libera el cupo',
    description:
      'Solo si la carrera todavia no ocurrio. Idempotente. El dorsal se conserva como registro ' +
      'historico: por eso los correlativos nunca se reutilizan.',
  })
  @ApiResponse({ status: 200, type: RegistrationDto })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'CANCELLATION_NOT_ALLOWED' })
  cancel(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.registrations.cancelar(userId, id);
  }
}

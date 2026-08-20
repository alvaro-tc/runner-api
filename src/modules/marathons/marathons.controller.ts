import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/dto/response-envelope';
import { Public } from '../auth/decorators/public.decorator';
import { MarathonsService } from './marathons.service';
import {
  ListMarathonsQueryDto,
  MarathonCategoryDto,
  MarathonDetailDto,
  MarathonExtraDto,
  MarathonSummaryDto,
  UpcomingQueryDto,
} from './dto/marathon.dto';

const LIMITE_UPCOMING_POR_DEFECTO = 5;

/**
 * El catalogo es **publico**.
 *
 * Una maraton publicada es informacion de difusion: se comparte por WhatsApp,
 * se abre desde un deep link antes de instalar la app y manana la lee el
 * front-end web. Exigir token para verla obligaria a registrarse solo para
 * mirar, y no protegeria nada que no este ya en el afiche de la carrera.
 *
 * Lo que sigue exigiendo token es inscribirse (Fase 7). Y lo no publicado no lo
 * ve nadie por aqui: para eso esta `/admin` (Fase 15).
 */
@ApiTags('marathons')
@Public()
@Controller('marathons')
export class MarathonsController {
  constructor(private readonly marathons: MarathonsService) {}

  @Get()
  @ApiOperation({
    summary: 'Catalogo de maratones publicadas',
    description:
      'Paginado por cursor y ordenado por fecha de largada. Con `status`, una pagina puede venir ' +
      'corta o vacia y traer `meta.nextCursor` igual: hay que paginar hasta que sea null.',
  })
  @ApiResponse({ status: 200, type: [MarathonSummaryDto] })
  list(@Query() query: ListMarathonsQueryDto) {
    return this.marathons.listar(query);
  }

  @Get('upcoming')
  @ApiOperation({
    summary: 'Proximas carreras, para el carrusel del home',
    description: 'Solo las que todavia no largaron, ordenadas de la mas proxima a la mas lejana.',
  })
  @ApiResponse({ status: 200, type: [MarathonSummaryDto] })
  upcoming(@Query() query: UpcomingQueryDto) {
    return this.marathons.proximas(query.limit ?? LIMITE_UPCOMING_POR_DEFECTO);
  }

  @Get(':slug')
  @ApiOperation({
    summary: 'Detalle de una maraton',
    description:
      'Acepta el slug o el id. Trae categorias y extras embebidos: son lo que pinta la pantalla ' +
      'de detalle, y pedirlos aparte serian tres viajes para una sola vista.',
  })
  @ApiParam({ name: 'slug', example: 'maraton-la-paz-3600' })
  @ApiResponse({ status: 200, type: MarathonDetailDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'NOT_FOUND' })
  detail(@Param('slug') slug: string) {
    return this.marathons.detalle(slug);
  }

  @Get(':id/categories')
  @ApiOperation({
    summary: 'Categorias de una maraton',
    description: 'Acepta el slug o el id. Existe suelto para el paso 2 de la inscripcion.',
  })
  @ApiResponse({ status: 200, type: [MarathonCategoryDto] })
  categories(@Param('id') id: string) {
    return this.marathons.categorias(id);
  }

  @Get(':id/extras')
  @ApiOperation({
    summary: 'Extras comprables de una maraton',
    description: 'Acepta el slug o el id. `stock: null` significa sin limite, no agotado.',
  })
  @ApiResponse({ status: 200, type: [MarathonExtraDto] })
  extras(@Param('id') id: string) {
    return this.marathons.extras(id);
  }
}

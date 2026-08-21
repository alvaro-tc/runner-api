import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/dto/response-envelope';
import { Public } from '../auth/decorators/public.decorator';
import { RoutesService } from './routes.service';
import {
  ListRoutesQueryDto,
  RouteDetailDto,
  RouteDetailQueryDto,
  RouteSummaryDto,
} from './dto/route.dto';

/**
 * Recorridos preestablecidos.
 *
 * **Publico**, por lo mismo que el catalogo de maratones: un trazado oficial es
 * informacion de difusion, y pedir token para verlo obligaria a registrarse
 * antes de saber por donde pasa la carrera. Cargarlos y editarlos es otra cosa
 * y vive en `/admin/routes`.
 */
@ApiTags('routes')
@Public()
@Controller('routes')
export class RoutesController {
  constructor(private readonly routes: RoutesService) {}

  @Get()
  @ApiOperation({
    summary: 'Recorridos disponibles',
    description:
      'Sin geometria: es la lista con la que se elige uno. Ordenados por ciudad y distancia.',
  })
  @ApiResponse({ status: 200, type: [RouteSummaryDto] })
  list(@Query() query: ListRoutesQueryDto) {
    return this.routes.listar(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Un recorrido con su trazado',
    description:
      'Acepta el slug o el id. El `LineString` viene simplificado para dibujarlo en el movil; ' +
      'con `?full=true` sale tal como se cargo.',
  })
  @ApiParam({ name: 'id', example: 'circuito-zona-sur' })
  @ApiResponse({ status: 200, type: RouteDetailDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'NOT_FOUND' })
  detail(@Param('id') id: string, @Query() query: RouteDetailQueryDto) {
    return this.routes.detalle(id, query.full ?? false);
  }
}

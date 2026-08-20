import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { HomeService } from './home.service';
import { HomeSummaryDto } from './dto/home.dto';

@ApiTags('home')
@ApiBearerAuth('access-token')
@Controller('home')
export class HomeController {
  constructor(private readonly home: HomeService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Todo el home en una sola llamada',
    description:
      'Maratón destacada, tiempo estimado de llegada, plan activo con su semana, sesión de hoy ' +
      'y la tira Mon–Sun cruzando lo corrido contra lo planificado.\n\n' +
      'Nada se cachea: el pull-to-refresh es volver a llamar aquí. La cuenta regresiva la ' +
      'calcula el cliente contra `meta.timestamp`, que es la hora del **servidor** — el reloj ' +
      'del teléfono puede ir minutos desviado y una carrera no empieza cuando él diga.',
  })
  @ApiResponse({ status: 200, type: HomeSummaryDto })
  summary(@CurrentUser('sub') userId: string) {
    return this.home.summary(userId);
  }
}

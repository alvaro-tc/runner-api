import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/dto/response-envelope';
import { Public } from '../auth/decorators/public.decorator';
import { QuoteService } from './quote.service';
import { QuoteRequestDto, QuoteResponseDto } from './dto/quote.dto';

@ApiTags('pricing')
@Controller('pricing')
export class PricingController {
  constructor(private readonly quotes: QuoteService) {}

  /**
   * Cotizacion de vista previa, antes de que exista una inscripcion.
   *
   * Es publico como el catalogo: se calcula solo sobre datos publicos (precio
   * de la carrera, recargo de categoria, extras) y no toca ni crea nada. Que el
   * precio que ve alguien sin cuenta sea el mismo que vera despues de
   * registrarse es lo minimo.
   *
   * Es POST y no GET porque la lista de extras es un array de objetos, y
   * meterla en la query string obliga a inventar una serializacion propia que
   * despues hay que mantener en Dart. No modifica nada.
   *
   * Durante el flujo de 3 pasos, la que manda es `GET /registrations/:id/quote`
   * (Fase 7): cotiza lo que hay guardado en la inscripcion.
   */
  @Public()
  @Post('quote')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Calcula el total de una inscripcion sin crearla',
    description:
      'No reserva cupo ni stock. Cotizar una carrera cerrada o llena esta permitido: quien ' +
      'decide si se puede comprar es el checkout.',
  })
  @ApiResponse({ status: 200, type: QuoteResponseDto })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'INVALID_CATEGORY / INVALID_EXTRA',
  })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'NOT_FOUND' })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'EXTRA_OUT_OF_STOCK' })
  async quote(@Body() dto: QuoteRequestDto): Promise<QuoteResponseDto> {
    const { marathonId, currency, items, subtotalCents, serviceFee, totalCents } =
      await this.quotes.cotizar(dto);

    // Se arma la respuesta campo por campo en vez de devolver la cotizacion
    // entera: `serviceFeeSnapshot` es para persistir al confirmar, lleva la
    // config interna del cargo y no le sirve de nada a la app. Enumerar lo
    // publico evita que un campo interno nuevo se filtre solo el dia que se
    // agregue.
    return { marathonId, currency, items, subtotalCents, serviceFee, totalCents };
  }
}

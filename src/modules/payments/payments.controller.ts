import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ErrorResponseDto } from '../../common/dto/response-envelope';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { PaymentsService } from './payments.service';
import { CheckoutDto, CheckoutResultDto, PaymentDto, ReceiptDto } from './dto/payment.dto';
import { WebhookEventDto, WebhookResultDto } from './dto/webhook.dto';
import { CABECERA_DE_FIRMA } from './webhook/signature';

/**
 * Cobros. Todo es del usuario del token: ninguna ruta recibe un `userId`, y un
 * pago ajeno responde 404 sin revelar que existe.
 *
 * El checkout vive aca y no en `registrations` porque el paso 3 es un cobro:
 * lleva cabecera de idempotencia y un proveedor detras. Con el en el otro
 * modulo, inscripciones dependeria de pagos y pagos de inscripciones.
 */
@ApiTags('payments')
@ApiBearerAuth('access-token')
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('registrations/:id/checkout')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Clave unica de este intento de cobro, generada por el cliente (un uuid v4 sirve). ' +
      'Reintentar con la misma clave devuelve el mismo resultado sin volver a cobrar; ' +
      'guardala junto al borrador para que sobreviva a un cierre de la app.',
  })
  @ApiOperation({
    summary: 'Paso 3: acepta terminos, cobra, reserva el cupo y asigna dorsal',
    description:
      'Recalcula el precio del lado del servidor: no se confia en el total que vio el cliente. ' +
      'Primero valida y congela el precio, despues cobra, y solo entonces toma el cupo dentro ' +
      'de una transaccion con la maraton bloqueada, asi que dos personas peleando el ultimo ' +
      'lugar no entran las dos. Si el cupo se va justo despues del cobro, se reembolsa solo. ' +
      'Con `card` la respuesta ya trae la inscripcion `confirmed`; con `qr` y `bank_transfer` ' +
      'vuelve `pending` y hay que sondear `GET /payments/:id`.',
  })
  @ApiResponse({ status: 200, type: CheckoutResultDto })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'IDEMPOTENCY_KEY_REQUIRED / CATEGORY_REQUIRED / PAYMENT_METHOD_NOT_SUPPORTED',
  })
  @ApiResponse({
    status: 402,
    type: ErrorResponseDto,
    description: 'PAYMENT_DECLINED. `details[0].reason` dice por que.',
  })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description:
      'MARATHON_FULL / REGISTRATION_CLOSED / EXTRA_OUT_OF_STOCK / IDEMPOTENCY_KEY_CONFLICT',
  })
  checkout(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
    @Body() dto: CheckoutDto,
    @Headers('idempotency-key') idempotencyKey: string,
  ) {
    return this.payments.checkout(userId, id, dto, idempotencyKey ?? '');
  }

  @Get('registrations/:id/payments')
  @ApiOperation({
    summary: 'Intentos de cobro de una inscripcion',
    description:
      'Del mas nuevo al mas viejo, rechazos incluidos. Es lo que se pinta en el detalle de ' +
      'Races junto al estado del pago.',
  })
  @ApiResponse({ status: 200, type: [PaymentDto] })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'NOT_FOUND' })
  listOfRegistration(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.payments.listarDeInscripcion(userId, id);
  }

  @Post('payments/:id/mock-confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Fuerza la confirmacion de un cobro pendiente (solo desarrollo)',
    description:
      'Atajo para no esperar los segundos del QR ni montar un banco falso mientras pruebas la ' +
      'pantalla a mano. **En produccion responde 404**: un endpoint que da por pagado lo que ' +
      'nadie pago no puede existir donde hay dinero de verdad.',
  })
  @ApiResponse({ status: 200, type: CheckoutResultDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'NOT_FOUND' })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'PAYMENT_ALREADY_SETTLED / MARATHON_FULL',
  })
  mockConfirm(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.payments.mockConfirm(userId, id);
  }

  @Get('payments/:id')
  @ApiOperation({
    summary: 'Detalle de un pago propio',
    description:
      'Es el endpoint de **polling** del QR: cada lectura resuelve el cobro si ya toca (se ' +
      'pago solo, o caduco), asi que basta con sondear esta ruta cada 2-3 s y mirar `status`. ' +
      'Deja de sondear cuando salga de `pending`.',
  })
  @ApiResponse({ status: 200, type: PaymentDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'NOT_FOUND' })
  detail(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.payments.obtener(userId, id);
  }

  @Get('payments/:id/receipt')
  @ApiOperation({
    summary: 'Comprobante de pago en PDF',
    description:
      'Devuelve la URL del PDF, en espanol y con los montos en Bs. Se genera la primera vez y ' +
      'se reutiliza: sale de los datos congelados de la inscripcion, asi que regenerarlo daria ' +
      'siempre lo mismo. **No es una factura**: no esta dosificado y no da credito fiscal.',
  })
  @ApiResponse({ status: 200, type: ReceiptDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'NOT_FOUND' })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'RECEIPT_NOT_AVAILABLE: el cobro no llego a `paid`',
  })
  receipt(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.payments.comprobante(userId, id);
  }

  /**
   * Webhook del proveedor.
   *
   * Publico —no lleva JWT, porque quien llama es un servidor, no un usuario— y
   * autenticado por **firma HMAC** sobre el cuerpo crudo. Es el mismo formato
   * que usa un PSP real, para que migrar sea cambiar el driver y no el flujo.
   */
  @Post('payments/webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiHeader({
    name: 'X-Paceup-Signature',
    required: true,
    description: 'Formato `t=<epoch>,v1=<hmac-sha256 de "t.cuerpo">`',
  })
  @ApiOperation({
    summary: 'Recibe un evento del proveedor de pagos',
    description:
      'Responde 200 aunque el evento no se pueda aplicar (`handled: false`): un proveedor que ' +
      'recibe un error reintenta, y reintentar algo que nunca vamos a poder procesar es un ' +
      'bucle. Solo la firma invalida corta con 401.',
  })
  @ApiResponse({ status: 200, type: WebhookResultDto })
  @ApiResponse({
    status: 401,
    type: ErrorResponseDto,
    description: 'INVALID_WEBHOOK_SIGNATURE: firma ausente, incorrecta o fuera de la ventana',
  })
  webhook(@Req() req: RawBodyRequest<Request>, @Body() evento: WebhookEventDto) {
    return this.payments.recibirWebhook(req.rawBody, req.headers[CABECERA_DE_FIRMA], evento);
  }
}

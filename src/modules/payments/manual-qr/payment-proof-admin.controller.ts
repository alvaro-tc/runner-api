import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../../common/dto/response-envelope';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { PaymentProofService } from './payment-proof.service';
import { ApproveProofDto, PendingProofDto, ProofDto, RejectProofDto } from './dto/proof.dto';

/** El mismo techo que el resto del panel: lo usa una persona haciendo clic. */
const LIMITE_ADMIN = { corto: { limit: 60, ttl: 60_000 } };

/**
 * TEMPORAL — cola de revision de comprobantes. Ver `docs/pago-qr-manual.md`.
 *
 * Vive bajo `/admin/*` como el resto del panel, pero en esta carpeta y no en
 * `AdminController`: el flujo entero se borra borrando `manual-qr/`.
 *
 * `@Roles('admin')` va **en la clase**. Un metodo nuevo que se olvidara el
 * decorador quedaria abierto a cualquier usuario logueado, y aqui lo que se
 * decide es si alguien pago o no.
 */
@ApiTags('admin')
@ApiBearerAuth('access-token')
@Roles('admin')
@Throttle(LIMITE_ADMIN)
@Controller('admin/payment-proofs')
export class PaymentProofAdminController {
  constructor(private readonly proofs: PaymentProofService) {}

  @Get()
  @ApiOperation({
    summary: 'Comprobantes esperando revision',
    description:
      'Cola de trabajo: del mas viejo al mas nuevo. Cada fila trae el corredor, su CI y el ' +
      'monto, para poder cuadrarlo contra el extracto sin abrir la imagen.',
  })
  @ApiResponse({ status: 200, type: [PendingProofDto] })
  pendientes(@Query('limit') limit?: string) {
    return this.proofs.pendientes(Number(limit) || 100);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dar el pago por recibido',
    description:
      'Acredita el cobro, reserva el cupo y emite el dorsal, por la **misma** via que el resto ' +
      'de los metodos. Si el cupo se agoto mientras el comprobante esperaba, el comprobante ' +
      'vuelve a la cola en vez de quedar aprobado sobre un cobro que sigue pendiente.',
  })
  @ApiResponse({ status: 200, type: ProofDto })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'PROOF_ALREADY_REVIEWED / MARATHON_FULL',
  })
  aprobar(
    @CurrentUser('sub') adminId: string,
    @Param('id') id: string,
    @Body() dto: ApproveProofDto,
  ) {
    return this.proofs.aprobar(id, adminId, dto.note);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rechazar el comprobante',
    description:
      'El cobro **sigue abierto**: lo normal es una captura equivocada, y cerrarlo obligaria a ' +
      'rehacer la inscripcion entera por una foto. El motivo lo ve el corredor.',
  })
  @ApiResponse({ status: 200, type: ProofDto })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'PROOF_ALREADY_REVIEWED' })
  rechazar(
    @CurrentUser('sub') adminId: string,
    @Param('id') id: string,
    @Body() dto: RejectProofDto,
  ) {
    return this.proofs.rechazar(id, adminId, dto.note);
  }
}

import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { ErrorResponseDto } from '../../../common/dto/response-envelope';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PrismaService } from '../../../database/prisma.service';
import { PaymentProofService } from './payment-proof.service';
import { ProofDto, UploadProofDto } from './dto/proof.dto';

/**
 * Tope del multipart. Es una **segunda** linea despues del limite real, que
 * vive en `PAYMENT_PROOF_MAX_BYTES` y se comprueba en el servicio: este corta el
 * cuerpo antes de leerlo entero, aquel da el mensaje de error bueno. Se pone
 * generoso a proposito para que el que manda el mensaje sea el servicio.
 */
const TOPE_MULTIPART = 12 * 1024 * 1024;

/**
 * TEMPORAL — comprobantes de pago del corredor. Ver `docs/pago-qr-manual.md`.
 *
 * Vive en su propio controlador y no dentro de `PaymentsController` para que
 * borrar el flujo el dia que entre una pasarela real sea borrar esta carpeta y
 * dos lineas de `payments.module.ts`.
 */
@ApiTags('payments')
@ApiBearerAuth('access-token')
@Controller('payments')
export class PaymentProofController {
  constructor(
    private readonly proofs: PaymentProofService,
    private readonly prisma: PrismaService,
  ) {}

  @Post(':id/proof')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: TOPE_MULTIPART, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        reference: { type: 'string', example: '00123456789' },
      },
    },
  })
  @ApiOperation({
    summary: 'Sube el comprobante del pago por QR',
    description:
      'El cobro **sigue `pending`**: subir el comprobante no es haber pagado. Queda ' +
      '`proof.status = in_review` hasta que un organizador lo apruebe, y solo entonces se ' +
      'emite el dorsal. Si te lo rechazan, sube otro: el cobro se mantiene abierto.',
  })
  @ApiResponse({ status: 201, type: ProofDto })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'PROOF_ALREADY_IN_REVIEW / PROOF_NOT_ALLOWED',
  })
  @ApiResponse({ status: 415, type: ErrorResponseDto, description: 'INVALID_IMAGE' })
  async upload(
    @CurrentUser('sub') userId: string,
    @Param('id') paymentId: string,
    @Body() dto: UploadProofDto,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ProofDto> {
    if (!file) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Falta el archivo en el campo `file`',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.exigirPropio(userId, paymentId);

    return this.proofs.subir(paymentId, file, dto.reference);
  }

  @Get(':id/proof')
  @ApiOperation({
    summary: 'El ultimo comprobante subido para ese cobro',
    description: 'Devuelve `null` si todavia no se subio ninguno.',
  })
  @ApiResponse({ status: 200, type: ProofDto })
  async latest(
    @CurrentUser('sub') userId: string,
    @Param('id') paymentId: string,
  ): Promise<ProofDto | null> {
    await this.exigirPropio(userId, paymentId);

    return this.proofs.ultimoDe(paymentId);
  }

  /**
   * El filtro por dueno de la inscripcion **es** la autorizacion, igual que en
   * `PaymentsService`. Un pago ajeno responde 404 sin revelar que existe.
   */
  private async exigirPropio(userId: string, paymentId: string): Promise<void> {
    const pago = await this.prisma.payment.findFirst({
      where: { id: paymentId, registration: { userId, deletedAt: null } },
      select: { id: true },
    });

    if (!pago) {
      throw new AppException(ErrorCode.NOT_FOUND, 'No se encontro ese pago', HttpStatus.NOT_FOUND);
    }
  }
}

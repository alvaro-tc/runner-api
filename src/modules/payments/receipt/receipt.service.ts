import { Injectable, Logger } from '@nestjs/common';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { AppConfigService } from '../../../config/app-config.service';
import { StorageService } from '../../storage/storage.service';
import { montoLiteral } from './amount-in-words';
import { formatearFecha, formatearMonto } from './money';
import type { PaymentMethod } from '../../../../generated/prisma/enums';

/** Versionar la plantilla evita devolver PDFs del diseño anterior. */
export const receiptKey = (paymentId: string): string =>
  `payments/receipts/cam-v1/${paymentId}.pdf`;

/** Una linea del desglose congelado, tal como se guardo en `quoteSnapshot`. */
export interface LineaDeComprobante {
  label: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
}

export interface DatosDelComprobante {
  paymentId: string;
  currency: string;
  externalId: string | null;
  paidAt: Date;
  method: PaymentMethod;
  methodDetails: { brand?: string; last4?: string; bank?: { reference?: string } };
  items: LineaDeComprobante[];
  subtotalCents: number;
  serviceFeeLabel: string | null;
  serviceFeeCents: number;
  totalCents: number;
  marathonName: string;
  marathonCity: string;
  marathonStartsAt: Date;
  marathonTimezone: string;
  bibNumber: string | null;
  runnerName: string;
  runnerDocId: string;
}

/** La imagen original es el fondo, sin recortes ni redibujado. Solo se
 * escriben los espacios vacios. Las coordenadas corresponden a sus 828 × 495.
 */
@Injectable()
export class ReceiptService {
  private readonly logger = new Logger(ReceiptService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly storage: StorageService,
  ) {}

  async generar(datos: DatosDelComprobante): Promise<string> {
    const pdf = await this.componer(datos);
    const guardado = await this.storage.save(receiptKey(datos.paymentId), pdf);
    this.logger.log(`Comprobante ${datos.paymentId} generado (${guardado.bytes} bytes)`);
    return guardado.url;
  }

  private componer(datos: DatosDelComprobante): Promise<Buffer> {
    return new Promise((resolver, rechazar) => {
      const doc = new PDFDocument({
        size: [828, 495],
        margin: 0,
        info: {
          Title: 'Recibo de donación',
          Author: 'Centro de Ayuda para la Mujer',
          CreationDate: datos.paidAt,
          ModDate: datos.paidAt,
        },
      });
      const trozos: Buffer[] = [];
      doc.on('data', (trozo: Buffer) => trozos.push(trozo));
      doc.on('end', () => resolver(Buffer.concat(trozos)));
      doc.on('error', rechazar);
      doc.image(join(__dirname, 'assets/donaciones.jpeg'), 0, 0, { width: 828, height: 495 });
      doc.font(join(__dirname, 'assets/Poppins-Regular.ttf')).fillColor('#202020');
      const zona = datos.marathonTimezone || this.config.get('DEFAULT_TIMEZONE');
      // El ID completo evita colisiones y permite encontrar el pago original.
      this.campo(doc, datos.paymentId, 660, 27, 156, 20, 9);
      this.campo(doc, datos.runnerName, 14, 252, 302, 35, 15);
      this.campo(doc, `Inscripción: ${datos.marathonName}`, 342, 252, 210, 35, 13);
      this.campo(
        doc,
        datos.currency === 'USD' ? '$US' : datos.currency === 'BOB' ? 'Bs.' : datos.currency,
        578,
        257,
        107,
        28,
        16,
      );
      this.campo(doc, formatearMonto(datos.totalCents), 707, 257, 109, 28, 16);
      this.campo(doc, montoLiteral(datos.totalCents), 154, 307, 487, 35, 13);
      this.campo(doc, formatearFecha(datos.paidAt, zona), 111, 375, 690, 30, 16);
      doc.end();
    });
  }

  /** Reduce la fuente para conservar TODO el valor dentro de su casilla.
   * No usa elipsis, no agrega paginas y no pisa el diseño de la plantilla. */
  private campo(
    doc: PDFKit.PDFDocument,
    valor: string,
    x: number,
    y: number,
    width: number,
    height: number,
    size: number,
  ): void {
    const texto = valor.replace(/\s+/g, ' ').trim();
    doc.fontSize(size);
    while (doc.heightOfString(texto, { width }) > height && size > 1) {
      size -= 0.25;
      doc.fontSize(size);
    }
    doc.text(texto, x, y, { width, height, align: 'center' });
  }
}

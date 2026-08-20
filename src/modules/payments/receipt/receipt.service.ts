import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { AppConfigService } from '../../../config/app-config.service';
import { StorageService } from '../../storage/storage.service';
import { formatearFecha, formatearMonto } from './money';
import type { PaymentMethod } from '../../../../generated/prisma/enums';

/** Una linea del desglose congelado, tal como se guardo en `quoteSnapshot`. */
export interface LineaDeComprobante {
  label: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
}

export interface DatosDelComprobante {
  paymentId: string;
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

const NOMBRE_DE_METODO: Record<string, string> = {
  card: 'Tarjeta',
  qr: 'Codigo QR',
  bank_transfer: 'Transferencia bancaria',
};

/**
 * Comprobante de pago en PDF, en espanol y con los montos en bolivianos.
 *
 * **No es una factura.** Es un comprobante de la operacion: no lleva codigo de
 * control, no esta dosificado y no sirve ante Impuestos Nacionales. Lo dice el
 * propio documento, en su pie, para que nadie lo presente creyendo que si. El
 * dia que haya facturacion electronica de verdad, este servicio pasa a emitirla
 * y el flujo de pagos no se entera.
 *
 * Se arma con los datos **congelados** de la inscripcion, no recotizando: un
 * comprobante que cambia porque el organizador subio un precio no es un
 * comprobante.
 */
@Injectable()
export class ReceiptService {
  private readonly logger = new Logger(ReceiptService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly storage: StorageService,
  ) {}

  /** Genera el PDF, lo guarda y devuelve su URL publica. */
  async generar(datos: DatosDelComprobante): Promise<string> {
    const pdf = await this.componer(datos);
    const guardado = await this.storage.save(`payments/receipts/${datos.paymentId}.pdf`, pdf);

    this.logger.log(`Comprobante ${datos.paymentId} generado (${guardado.bytes} bytes)`);

    return guardado.url;
  }

  /**
   * Dibuja el documento.
   *
   * `pdfkit` es una API de flujo: se escribe de arriba abajo y `doc.y` avanza
   * solo. Se acumula en memoria y se resuelve al cerrar, porque el archivo son
   * unos pocos kilobytes y una tuberia a disco solo anadiria estados de error
   * a medio camino.
   */
  private componer(datos: DatosDelComprobante): Promise<Buffer> {
    return new Promise((resolver, rechazar) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const trozos: Buffer[] = [];

      doc.on('data', (trozo: Buffer) => trozos.push(trozo));
      doc.on('end', () => resolver(Buffer.concat(trozos)));
      doc.on('error', rechazar);

      const zona = datos.marathonTimezone || this.config.get('DEFAULT_TIMEZONE');

      this.encabezado(doc, datos, zona);
      this.datosDeLaCarrera(doc, datos, zona);
      this.desglose(doc, datos);
      this.formaDePago(doc, datos);
      this.pie(doc);

      doc.end();
    });
  }

  private encabezado(doc: PDFKit.PDFDocument, datos: DatosDelComprobante, zona: string): void {
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .text(this.config.get('INVOICE_LEGAL_NAME'))
      .fontSize(9)
      .font('Helvetica')
      .text(`NIT ${this.config.get('INVOICE_NIT')}`)
      .text(this.config.get('INVOICE_ADDRESS'))
      .moveDown(1.2);

    doc.fontSize(15).font('Helvetica-Bold').text('COMPROBANTE DE PAGO').moveDown(0.4);

    doc
      .fontSize(9)
      .font('Helvetica')
      .text(`Nro. ${datos.externalId ?? datos.paymentId}`)
      .text(`Fecha de pago: ${formatearFecha(datos.paidAt, zona)}`)
      .moveDown(1);

    this.separador(doc);
  }

  private datosDeLaCarrera(
    doc: PDFKit.PDFDocument,
    datos: DatosDelComprobante,
    zona: string,
  ): void {
    doc.moveDown(0.6).fontSize(11).font('Helvetica-Bold').text('Inscripcion').moveDown(0.3);

    doc.fontSize(9).font('Helvetica');

    this.campo(doc, 'Corredor', datos.runnerName);
    this.campo(doc, 'Documento', datos.runnerDocId);
    this.campo(doc, 'Carrera', `${datos.marathonName} (${datos.marathonCity})`);
    this.campo(doc, 'Fecha de la carrera', formatearFecha(datos.marathonStartsAt, zona));

    if (datos.bibNumber) this.campo(doc, 'Dorsal', datos.bibNumber);

    doc.moveDown(0.8);
    this.separador(doc);
  }

  private desglose(doc: PDFKit.PDFDocument, datos: DatosDelComprobante): void {
    const izquierda = doc.page.margins.left;
    const derecha = doc.page.width - doc.page.margins.right;
    const columnaCantidad = derecha - 200;
    const columnaUnitario = derecha - 150;
    const columnaImporte = derecha - 80;

    doc.moveDown(0.6).fontSize(11).font('Helvetica-Bold').text('Detalle').moveDown(0.4);

    doc.fontSize(8).font('Helvetica-Bold');
    const cabecera = doc.y;
    doc.text('Concepto', izquierda, cabecera);
    doc.text('Cant.', columnaCantidad, cabecera, { width: 40, align: 'right' });
    doc.text('P. unit.', columnaUnitario, cabecera, { width: 60, align: 'right' });
    doc.text('Importe', columnaImporte, cabecera, { width: 80, align: 'right' });
    doc.moveDown(0.6);

    doc.fontSize(9).font('Helvetica');

    for (const item of datos.items) {
      const fila = doc.y;
      // El ancho del concepto se acota para que un nombre largo no se meta
      // debajo de los numeros: pdfkit no tiene tablas, las columnas son
      // coordenadas y hay que respetarlas a mano.
      doc.text(item.label, izquierda, fila, { width: columnaCantidad - izquierda - 10 });
      const siguiente = doc.y;
      doc.text(String(item.quantity), columnaCantidad, fila, { width: 40, align: 'right' });
      doc.text(formatearMonto(item.unitPriceCents), columnaUnitario, fila, {
        width: 60,
        align: 'right',
      });
      doc.text(formatearMonto(item.amountCents), columnaImporte, fila, {
        width: 80,
        align: 'right',
      });
      doc.y = siguiente;
      doc.moveDown(0.3);
    }

    doc.moveDown(0.4);
    this.separador(doc);
    doc.moveDown(0.5);

    this.totalDerecha(doc, 'Subtotal', datos.subtotalCents, columnaUnitario, columnaImporte);

    // Si el cargo por servicio estaba desactivado, la linea no se pinta: un
    // "Bs 0,00" invita a preguntar por un cobro que no existe.
    if (datos.serviceFeeCents > 0) {
      this.totalDerecha(
        doc,
        datos.serviceFeeLabel ?? 'Cargo por servicio',
        datos.serviceFeeCents,
        columnaUnitario,
        columnaImporte,
      );
    }

    doc.moveDown(0.2).fontSize(11).font('Helvetica-Bold');
    this.totalDerecha(doc, 'TOTAL', datos.totalCents, columnaUnitario, columnaImporte, true);
  }

  private formaDePago(doc: PDFKit.PDFDocument, datos: DatosDelComprobante): void {
    doc.moveDown(1.2).fontSize(11).font('Helvetica-Bold').text('Forma de pago').moveDown(0.3);

    doc.fontSize(9).font('Helvetica');

    this.campo(doc, 'Metodo', NOMBRE_DE_METODO[datos.method] ?? datos.method);

    if (datos.methodDetails.last4) {
      const marca = datos.methodDetails.brand ?? 'tarjeta';
      this.campo(doc, 'Tarjeta', `${marca.toUpperCase()} **** ${datos.methodDetails.last4}`);
    }

    if (datos.methodDetails.bank?.reference) {
      this.campo(doc, 'Referencia', datos.methodDetails.bank.reference);
    }

    this.campo(doc, 'Moneda', 'BOB (bolivianos)');
  }

  private pie(doc: PDFKit.PDFDocument): void {
    doc.moveDown(2);
    this.separador(doc);
    doc
      .moveDown(0.5)
      .fontSize(7.5)
      .font('Helvetica')
      .fillColor('#555555')
      .text(
        'Este documento es un comprobante de la operacion y no constituye factura ni nota ' +
          'fiscal: no esta dosificado ante el Servicio de Impuestos Nacionales y no da derecho ' +
          'a credito fiscal.',
        { align: 'left' },
      )
      .moveDown(0.3)
      .text('Generado automaticamente por PaceUp. Pago procesado en entorno de simulacion.')
      .fillColor('#000000');
  }

  private campo(doc: PDFKit.PDFDocument, etiqueta: string, valor: string): void {
    const inicio = doc.y;
    doc.font('Helvetica-Bold').text(`${etiqueta}:`, doc.page.margins.left, inicio, { width: 120 });
    doc.font('Helvetica').text(valor, doc.page.margins.left + 125, inicio);
    doc.moveDown(0.15);
  }

  private totalDerecha(
    doc: PDFKit.PDFDocument,
    etiqueta: string,
    centavos: number,
    columnaEtiqueta: number,
    columnaImporte: number,
    destacado = false,
  ): void {
    const fila = doc.y;

    if (!destacado) doc.fontSize(9).font('Helvetica');

    doc.text(etiqueta, columnaEtiqueta - 120, fila, { width: 180, align: 'right' });
    doc.text(formatearMonto(centavos), columnaImporte, fila, { width: 80, align: 'right' });
    doc.moveDown(0.3);
  }

  private separador(doc: PDFKit.PDFDocument): void {
    doc
      .strokeColor('#cccccc')
      .lineWidth(0.5)
      .moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .stroke()
      .strokeColor('#000000');
  }
}

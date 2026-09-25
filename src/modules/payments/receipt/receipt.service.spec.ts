import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfigService } from '../../../config/app-config.service';
import type { StorageService } from '../../storage/storage.service';
import { ReceiptService, type DatosDelComprobante } from './receipt.service';

export const datosRecibo: DatosDelComprobante = {
  paymentId: '8c837ee1-78f0-4af1-9e24-9aaae1c81fc2',
  currency: 'BOB',
  externalId: null,
  paidAt: new Date('2026-09-25T14:30:00Z'),
  method: 'qr_manual',
  methodDetails: {},
  items: [],
  subtotalCents: 15050,
  serviceFeeLabel: null,
  serviceFeeCents: 0,
  totalCents: 15050,
  marathonName: 'Carrera solidaria por la mujer',
  marathonCity: 'La Paz',
  marathonStartsAt: new Date('2026-10-01T12:00:00Z'),
  marathonTimezone: 'America/La_Paz',
  bibNumber: '001',
  runnerName: 'María Fernanda Quispe Mamani',
  runnerDocId: '1234567',
};

describe('Recibo con la plantilla original', () => {
  it.each([
    datosRecibo,
    {
      ...datosRecibo,
      runnerName: 'María Fernanda '.repeat(15),
      marathonName: 'Carrera solidaria '.repeat(15),
      totalCents: 2147483647,
      currency: 'USD',
    },
  ])('conserva los bytes JPEG, proporciones y una sola página', async (datos) => {
    const save = jest.fn((key: string, bytes: Buffer) =>
      Promise.resolve({
        key,
        url: key,
        bytes: bytes.length,
      }),
    );
    const service = new ReceiptService(
      { get: () => 'America/La_Paz' } as unknown as AppConfigService,
      { save } as unknown as StorageService,
    );
    await service.generar(datos);
    const pdf = save.mock.calls[0]![1];
    const original = readFileSync(join(__dirname, 'assets/donaciones.jpeg'));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    // PDFKit incrusta el JPEG original; no lo vuelve a comprimir ni lo modifica.
    expect(pdf.includes(original)).toBe(true);
    expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(1);
    expect(pdf.toString('latin1')).toContain('/MediaBox [0 0 828 495]');
    expect(save.mock.calls[0]![0]).toBe(`payments/receipts/cam-v1/${datos.paymentId}.pdf`);
  });
});

import { PaymentMethod, PaymentStatus } from '../../../../generated/prisma/enums';
import { glosaDe, intentoDeQrManual } from './qr-intent';

const base = {
  amountCents: 20000,
  currency: 'BOB',
  qrImageUrl: 'https://api.test/uploads/qr/lapaz.png',
  instructions: 'Poné la glosa en el detalle',
  reference: 'PU-A1B2C3',
  ttlHoras: 48,
};

describe('intentoDeQrManual', () => {
  it('abre el cobro PENDIENTE: ver un QR no es haber pagado', () => {
    expect(intentoDeQrManual(base).status).toBe(PaymentStatus.pending);
  });

  it('no inventa un proveedor: el externalId se marca como manual', () => {
    expect(intentoDeQrManual(base).externalId).toMatch(/^manual_/);
  });

  it('lleva el QR del organizador en su propio campo, no en el del QR simulado', () => {
    const intento = intentoDeQrManual(base);

    expect(intento.method).toBe(PaymentMethod.qr_manual);
    expect(intento.methodDetails.manualQr).toEqual({
      imageUrl: base.qrImageUrl,
      instructions: base.instructions,
      reference: base.reference,
    });
    // El `qr` del proveedor simulado tiene que quedar vacio: son dos cosas.
    expect(intento.methodDetails.qr).toBeUndefined();
  });

  it('caduca, o un QR sin pagar bloquearia un cupo para siempre', () => {
    const antes = Date.now();
    const vence = intentoDeQrManual(base).expiresAt;

    expect(vence).not.toBeNull();
    expect(vence!.getTime() - antes).toBeGreaterThan(47 * 60 * 60 * 1000);
    expect(vence!.getTime() - antes).toBeLessThanOrEqual(48 * 60 * 60 * 1000 + 1000);
  });

  it('cada intento es unico: dos cobros no comparten externalId', () => {
    expect(intentoDeQrManual(base).externalId).not.toBe(intentoDeQrManual(base).externalId);
  });
});

describe('glosaDe', () => {
  it('cabe en el campo de glosa de una banca movil', () => {
    expect(glosaDe('clx8a9b0c1d2e3f4g5h6i7j8').length).toBeLessThanOrEqual(12);
  });

  it('distingue dos inscripciones', () => {
    expect(glosaDe('reg_aaaaaa')).not.toBe(glosaDe('reg_bbbbbb'));
  });

  it('sale en mayusculas: es lo que el corredor va a teclear', () => {
    expect(glosaDe('reg_abcdef')).toBe('PU-ABCDEF');
  });
});

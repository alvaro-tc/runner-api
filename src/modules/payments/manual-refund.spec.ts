import { PaymentMethod, PaymentStatus } from '../../../generated/prisma/enums';
import { PaymentsService } from './payments.service';

/**
 * La devolucion ordenada desde el panel.
 *
 * Lo que se prueba es lo que duele si se rompe en silencio: que devolver
 * **suelte el cupo** —un reembolso que deja la plaza ocupada la bloquea para
 * siempre—, que quede firmado con quien lo ordeno, y que dos clics seguidos no
 * suelten la plaza dos veces.
 */
describe('devolucion manual de un cobro', () => {
  const PAGO = {
    id: 'pay_1',
    registrationId: 'reg_1',
    status: PaymentStatus.paid,
    method: PaymentMethod.qr_manual,
    externalId: null,
  };

  const findUnique = jest.fn();
  const updateMany = jest.fn();
  const findUniqueOrThrow = jest.fn();
  const liberarPorReembolso = jest.fn();
  const refund = jest.fn();

  const payments = Object.assign(Object.create(PaymentsService.prototype) as object, {
    prisma: { payment: { findUnique, updateMany, findUniqueOrThrow } },
    registrations: { liberarPorReembolso },
    provider: { refund },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }) as unknown as PaymentsService;

  beforeEach(() => {
    jest.clearAllMocks();
    findUnique.mockResolvedValue(PAGO);
    updateMany.mockResolvedValue({ count: 1 });
    findUniqueOrThrow.mockResolvedValue({ ...PAGO, status: PaymentStatus.refunded });
  });

  const devolver = () => payments.reembolsarManualmente('pay_1', 'admin_1', 'lluvia');

  it('deja el cobro devuelto y firmado con quien lo ordeno', async () => {
    await devolver();

    expect(updateMany).toHaveBeenCalledWith({
      // Condicionado a `paid`: es lo que hace la operacion idempotente.
      where: { id: 'pay_1', status: PaymentStatus.paid },
      data: expect.objectContaining({
        status: PaymentStatus.refunded,
        failureReason: 'lluvia',
        refundedById: 'admin_1',
      }),
    });
  });

  it('suelta el cupo: quien recupera su dinero no corre', async () => {
    await devolver();

    expect(liberarPorReembolso).toHaveBeenCalledWith('reg_1');
  });

  it('un cobro que no esta pagado no se devuelve', async () => {
    findUnique.mockResolvedValue({ ...PAGO, status: PaymentStatus.pending });

    await expect(devolver()).rejects.toThrow();
    expect(liberarPorReembolso).not.toHaveBeenCalled();
  });

  it('el segundo clic no suelta la plaza otra vez', async () => {
    // Alguien mas cerro el cobro entre la lectura y la escritura: el update
    // condicionado no toca ninguna fila, y ahi se corta.
    updateMany.mockResolvedValue({ count: 0 });

    await expect(devolver()).rejects.toThrow();
    expect(liberarPorReembolso).not.toHaveBeenCalled();
  });

  it('sin proveedor detras no se le pide nada a nadie', async () => {
    await devolver();

    expect(refund).not.toHaveBeenCalled();
  });

  it('con proveedor, se le pide la devolucion', async () => {
    findUnique.mockResolvedValue({
      ...PAGO,
      method: PaymentMethod.card,
      externalId: 'ext_1',
    });

    await devolver();

    expect(refund).toHaveBeenCalledWith('ext_1');
  });

  it('si el proveedor falla, el cupo se suelta igual', async () => {
    findUnique.mockResolvedValue({
      ...PAGO,
      method: PaymentMethod.card,
      externalId: 'ext_1',
    });
    refund.mockRejectedValue(new Error('proveedor caido'));

    await devolver();

    // El cobro ya consta como devuelto; dejar la plaza ocupada ademas seria
    // castigar al corredor por una caida que no es suya.
    expect(liberarPorReembolso).toHaveBeenCalledWith('reg_1');
  });
});

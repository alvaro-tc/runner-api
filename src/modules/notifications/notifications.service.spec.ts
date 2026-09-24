import { NotificationsService } from './notifications.service';

/**
 * La regla que importa: la bandeja se escribe siempre y el push respeta las
 * preferencias. Si se invierte, la campana deja de contar lo que el usuario
 * apago en el telefono.
 */
describe('NotificationsService.notify', () => {
  const fila = {
    id: 'n1',
    userId: 'u1',
    type: 'payment.approved',
    title: 'Pago validado',
    body: '...',
    data: { registrationId: 'r1' },
    readAt: null,
    createdAt: new Date('2026-09-24T12:00:00Z'),
  };

  function montar(pushApagado: boolean) {
    const prisma = {
      notification: { create: jest.fn().mockResolvedValue(fila) },
      userPreferences: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ notifications: pushApagado ? { push: false } : {} }),
      },
      device: { findMany: jest.fn().mockResolvedValue([{ pushToken: 't1' }]) },
    };
    const sender = { send: jest.fn().mockResolvedValue(undefined) };
    const live = { anunciarNotificacion: jest.fn() };
    const service = new NotificationsService(prisma as never, sender, live as never);
    return { service, prisma, sender, live };
  }

  const evento = {
    type: 'payment.approved' as const,
    paymentId: 'p1',
    registrationId: 'r1',
    marathonId: 'm1',
    marathonName: 'Maraton CAM',
    bibNumber: '0042',
  };

  it('guarda, avisa por socket y manda el push', async () => {
    const { service, prisma, sender, live } = montar(false);
    await service.notify('u1', evento);

    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1',
        type: 'payment.approved',
        data: expect.objectContaining({ registrationId: 'r1', bibNumber: '0042' }),
      }),
    });
    expect(live.anunciarNotificacion).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ id: 'n1' }),
    );
    expect(sender.send).toHaveBeenCalledWith(expect.objectContaining({ tokens: ['t1'] }));
  });

  it('el rechazo lleva el motivo a la app, que es lo que el corredor corrige', async () => {
    const { service, prisma } = montar(false);
    await service.notify('u1', {
      type: 'payment.rejected',
      paymentId: 'p1',
      registrationId: 'r1',
      marathonId: 'm1',
      marathonName: 'Maraton CAM',
      reason: 'Captura borrosa',
    });

    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'payment.rejected',
        data: expect.objectContaining({ reason: 'Captura borrosa', marathonId: 'm1' }),
      }),
    });
  });

  it('con los push apagados sigue guardando en la bandeja', async () => {
    const { service, prisma, sender } = montar(true);
    await service.notify('u1', evento);

    expect(prisma.notification.create).toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });
});

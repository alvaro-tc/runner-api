import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { PaymentsService } from '../payments.service';

/** receiptUrl = null en un pago confirmado es la cola persistente de emisión.
 * Recupera fallos de disco y reinicios sin volver a cobrar ni validar el pago. */
@Injectable()
export class ReceiptRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReceiptRecoveryService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private after?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.recover(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async recover(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const pagos = await this.prisma.payment.findMany({
        where: {
          status: 'paid',
          receiptUrl: null,
          registration: { status: 'confirmed' },
          ...(this.after ? { id: { gt: this.after } } : {}),
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 50,
      });
      for (const pago of pagos) await this.payments.asegurarRecibo(pago.id);
      this.after = pagos.length === 50 ? pagos.at(-1)?.id : undefined;
    } catch (error) {
      this.logger.error('No se pudo recuperar la emisión de recibos', error);
    } finally {
      this.running = false;
    }
  }
}

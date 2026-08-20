import { log, prisma, titulo } from './comun';

/**
 * Config global del cargo por servicio: 10% con minimo de Bs 5, **apagada**.
 *
 * El PROMT pedia sembrarla encendida; la Fase 0 decidio lo contrario y esa
 * decision manda (ver `docs/decisiones.md`): el fee arranca invisible y se
 * enciende desde el panel cuando el producto lo quiera. Los valores quedan
 * precargados justamente para que encenderlo sea un click, sin migracion ni
 * redeploy, y probar los dos caminos sea cuestion de un interruptor.
 *
 * Idempotente: si ya hay una global se respeta como este, encendida o apagada.
 * Reescribirla en cada `db:seed` desharia lo que alguien acaba de cambiar
 * desde el panel.
 */
export async function sembrarServiceFee(): Promise<void> {
  titulo('Cargo por servicio');

  const existente = await prisma.serviceFeeConfig.findFirst({ where: { scope: 'global' } });

  if (existente) {
    log(`config global ya existe (enabled=${existente.enabled})`);
    return;
  }

  await prisma.serviceFeeConfig.create({
    data: {
      scope: 'global',
      enabled: false,
      type: 'percent',
      percentBps: 1000, // 10%
      minCents: 500, // Bs 5,00
      label: 'Cargo por servicio',
    },
  });

  log('config global creada: 10%, minimo Bs 5, apagada');
}

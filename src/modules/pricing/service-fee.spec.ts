import { ServiceFeeScope, ServiceFeeType } from '../../../generated/prisma/enums';
import { calcularServiceFee, type ConfigDeFee } from './service-fee';

describe('calcularServiceFee', () => {
  const ahora = new Date('2026-08-18T12:00:00Z');

  const base: ConfigDeFee = {
    id: 'cfg-1',
    scope: ServiceFeeScope.global,
    enabled: true,
    type: ServiceFeeType.percent,
    percentBps: 1000, // 10%
    fixedCents: null,
    minCents: null,
    maxCents: null,
    label: 'Cargo por servicio',
  };

  describe('apagado', () => {
    it('devuelve null cuando la config esta desactivada', () => {
      expect(calcularServiceFee({ ...base, enabled: false }, 25_000, ahora)).toBeNull();
    });

    it('devuelve null cuando no hay ninguna config', () => {
      expect(calcularServiceFee(null, 25_000, ahora)).toBeNull();
    });

    it('null y no cero: la UI no debe pintar una linea de Bs 0,00', () => {
      const resultado = calcularServiceFee({ ...base, enabled: false }, 25_000, ahora);

      expect(resultado).toBeNull();
      expect(resultado).not.toEqual({ amountCents: 0 });
    });
  });

  describe('porcentaje', () => {
    it('aplica los puntos basicos sobre el subtotal', () => {
      expect(calcularServiceFee(base, 25_000, ahora)?.amountCents).toBe(2_500);
    });

    it('redondea al centavo, con los medios hacia arriba', () => {
      // 1005 * 5% = 50,25 → 50
      expect(calcularServiceFee({ ...base, percentBps: 500 }, 1_005, ahora)?.amountCents).toBe(50);
      // 1010 * 5% = 50,5 → 51
      expect(calcularServiceFee({ ...base, percentBps: 500 }, 1_010, ahora)?.amountCents).toBe(51);
    });
  });

  describe('monto fijo', () => {
    it('cobra siempre lo mismo, sin mirar el subtotal', () => {
      const fijo: ConfigDeFee = { ...base, type: ServiceFeeType.fixed, fixedCents: 500 };

      expect(calcularServiceFee(fijo, 25_000, ahora)?.amountCents).toBe(500);
      expect(calcularServiceFee(fijo, 100_000, ahora)?.amountCents).toBe(500);
    });
  });

  describe('mixto', () => {
    it('suma el porcentaje y el fijo', () => {
      const mixto: ConfigDeFee = {
        ...base,
        type: ServiceFeeType.mixed,
        percentBps: 500,
        fixedCents: 300,
      };

      // 25000 * 5% = 1250, + 300 = 1550
      expect(calcularServiceFee(mixto, 25_000, ahora)?.amountCents).toBe(1_550);
    });
  });

  describe('minimo y maximo', () => {
    it('el minimo levanta un porcentaje que quedo corto', () => {
      // 1000 * 10% = 100, pero el minimo es 500
      expect(calcularServiceFee({ ...base, minCents: 500 }, 1_000, ahora)?.amountCents).toBe(500);
    });

    it('el maximo corta un porcentaje que se disparo', () => {
      // 500000 * 10% = 50000, pero el techo es 3000
      expect(calcularServiceFee({ ...base, maxCents: 3_000 }, 500_000, ahora)?.amountCents).toBe(
        3_000,
      );
    });

    it('con minimo y maximo cruzados, manda el maximo', () => {
      const cruzada = { ...base, minCents: 5_000, maxCents: 1_000 };

      expect(calcularServiceFee(cruzada, 25_000, ahora)?.amountCents).toBe(1_000);
    });
  });

  describe('subtotal cero', () => {
    it('una inscripcion gratuita no paga cargo, ni siquiera el minimo', () => {
      expect(calcularServiceFee({ ...base, minCents: 500 }, 0, ahora)).toBeNull();
    });

    it('un subtotal negativo tampoco genera cargo', () => {
      expect(calcularServiceFee(base, -100, ahora)).toBeNull();
    });
  });

  describe('snapshot', () => {
    it('guarda la config exacta y la base sobre la que se calculo', () => {
      const config: ConfigDeFee = {
        ...base,
        scope: ServiceFeeScope.marathon,
        type: ServiceFeeType.mixed,
        percentBps: 800,
        fixedCents: 200,
        minCents: 500,
        maxCents: 10_000,
        label: 'Gestion',
      };

      const aplicado = calcularServiceFee(config, 25_000, ahora);

      expect(aplicado?.snapshot).toEqual({
        configId: 'cfg-1',
        scope: 'marathon',
        type: 'mixed',
        percentBps: 800,
        fixedCents: 200,
        minCents: 500,
        maxCents: 10_000,
        label: 'Gestion',
        subtotalCents: 25_000,
        amountCents: 2_200,
        appliedAt: '2026-08-18T12:00:00.000Z',
      });
    });

    it('el snapshot alcanza para recalcular el monto sin la config viva', () => {
      const aplicado = calcularServiceFee(base, 25_000, ahora);
      const s = aplicado?.snapshot;

      expect(Math.round((s!.subtotalCents * s!.percentBps!) / 10_000)).toBe(s?.amountCents);
    });
  });
});

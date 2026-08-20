import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * Cliente y utilidades compartidas por los modulos del seed.
 *
 * Uno solo para todo el seed: cada `new PrismaClient()` abre su propio pool, y
 * cuatro pools contra la misma base solo sirven para agotar conexiones.
 */
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL'] }),
});

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/**
 * Fecha relativa al momento de correr el seed. Negativo = pasado.
 *
 * Todas las fechas del seed salen de aqui y ninguna es absoluta: con fechas
 * fijas el catalogo de ejemplo se vence solo y a las pocas semanas todo aparece
 * `closed`, que es justo el estado en el que no se puede probar nada.
 */
export const enDias = (dias: number): Date => new Date(Date.now() + dias * MS_POR_DIA);

/** Como `enDias`, pero fijando la hora local de la carrera (UTC-4 en Bolivia). */
export function enDiasAHora(dias: number, horaLocal: number): Date {
  const fecha = enDias(dias);
  fecha.setUTCHours(horaLocal + 4, 0, 0, 0);

  return fecha;
}

/** Redondeo a multiplo, para que las distancias no salgan con decimales feos. */
export const aMultiplo = (valor: number, multiplo: number): number =>
  Math.round(valor / multiplo) * multiplo;

export function log(mensaje: string): void {
  console.log(`  ${mensaje}`);
}

export function titulo(mensaje: string): void {
  console.log(`\n▸ ${mensaje}`);
}

// ─── Circuitos ────────────────────────────────────────────────────────────

/** Grados de latitud por metro. Un grado son ~111.320 m. */
export const GRADOS_POR_METRO = 1 / 111_320;

/**
 * Cuanto se deforma el circulo base. Un circulo perfecto se ve sintetico en
 * cuanto se dibuja sobre un mapa.
 */
export const DEFORMACION = 0.18;

/** Radio del circuito deformado, en grados, para que MIDA `distanceMeters`.
 *
 * El detalle que se paga por olvidar: deformar el circulo lo **alarga**. Con
 * `r(θ) = R(1 + 0,18·sin3θ)` el perimetro crece un 7%, asi que usar el radio de
 * un circulo de la distancia pedida daba entrenamientos de 10.700 m cuando el
 * generador creia estar dibujando 10.000. Se corrige integrando el perimetro
 * real de la curva una sola vez.
 */
export function radioDeCircuito(distanceMeters: number): number {
  return (distanceMeters * GRADOS_POR_METRO) / PERIMETRO_UNITARIO;
}

/** Perimetro de la curva con R = 1, integrado numericamente. */
const PERIMETRO_UNITARIO = (() => {
  const PASOS = 2000;
  let largo = 0;

  for (let i = 0; i < PASOS; i++) {
    const t = (i / PASOS) * 2 * Math.PI;
    const r = 1 + DEFORMACION * Math.sin(3 * t);
    const dr = 3 * DEFORMACION * Math.cos(3 * t);
    largo += Math.sqrt(r * r + dr * dr) * ((2 * Math.PI) / PASOS);
  }

  return largo;
})();

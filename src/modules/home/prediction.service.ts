import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import type { Esfuerzo } from '../training-plans/pace-basis';
import { predecir, SEMANAS_DE_HISTORIAL, type Prediccion } from './prediction';

const MS_POR_SEMANA = 7 * 24 * 60 * 60 * 1000;

/**
 * Tope de entrenamientos que entran en el calculo.
 *
 * Doscientos en doce semanas son mas de dos al dia: nadie va a quedarse fuera
 * por el tope, y evita traerse el historial entero de una cuenta con un
 * sincronizador desbocado. Se cogen los mas recientes, que son los que mandan.
 */
const MAX_ESFUERZOS = 200;

/**
 * Tiempo estimado de llegada.
 *
 * Se lee entero desde los entrenamientos del usuario: la formula no toca la
 * base y la base no toca la formula, asi que ajustar la prediccion es cambiar
 * `prediction.ts` y correr su test, sin levantar Postgres.
 */
@Injectable()
export class PredictionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Que tiempo haria este usuario en esa distancia.
   *
   * Devuelve `reason: 'insufficient_data'` —no un error— cuando no hay con que
   * predecir: en el home eso no es un fallo, es un corredor que acaba de
   * empezar, y la pantalla tiene que saber pintar ese caso sin un catch.
   */
  async estimar(userId: string, distanciaObjetivoMetros: number): Promise<Prediccion> {
    return predecir(await this.esfuerzosRecientes(userId), distanciaObjetivoMetros);
  }

  /**
   * Los entrenamientos de la ventana, sin los borrados.
   *
   * Se piden distancia y duracion y nada mas: es lo unico que come la formula, y
   * un `select` estrecho sobre una tabla que crece cada dia se nota.
   */
  private async esfuerzosRecientes(userId: string): Promise<Esfuerzo[]> {
    return this.prisma.workout.findMany({
      where: {
        userId,
        deletedAt: null,
        startedAt: { gte: new Date(Date.now() - SEMANAS_DE_HISTORIAL * MS_POR_SEMANA) },
        distanceMeters: { gt: 0 },
      },
      select: { distanceMeters: true, durationSeconds: true },
      orderBy: { startedAt: 'desc' },
      take: MAX_ESFUERZOS,
    });
  }
}

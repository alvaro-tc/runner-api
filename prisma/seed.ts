import { prisma } from './seed/comun';
import { sembrarServiceFee } from './seed/service-fee';
import { sembrarUsuarios, PASSWORD_DE_PRUEBA } from './seed/usuarios';
import { sembrarMaratones } from './seed/maratones';
import { sembrarPlantillas } from './seed/planes';
import { sembrarInscripciones } from './seed/inscripciones';
import {
  sembrarDispositivo,
  sembrarEntrenamientos,
  sembrarPlanActivo,
  sembrarZapatillas,
} from './seed/entrenamientos';

/**
 * `npm run db:seed` deja un entorno usable de inmediato: tres cuentas, un
 * catalogo de maratones con los cuatro estados representados, el catalogo de
 * planes y un corredor con cuatro meses de actividad encima —entrenamientos con
 * GPS, un plan a medias, inscripciones y una carrera corrida con su resultado.
 *
 * **Todo el seed es idempotente**, identificando cada fila por su clave natural
 * (email, slug). Correrlo dos veces no duplica nada y, mas importante, no pisa
 * lo que se haya editado desde el panel: un seed que sobreescribe es un seed que
 * nadie se anima a correr sobre una base con la que estaba trabajando.
 */
async function main(): Promise<void> {
  await sembrarServiceFee();
  const usuarios = await sembrarUsuarios();
  await sembrarMaratones();
  await sembrarPlantillas();

  // El corredor principal es el unico con actividad sembrada. `runner2` queda
  // vacio a proposito: es la cuenta con la que se comprueba que los datos de
  // uno no se ven desde la sesion de otro.
  const runner = usuarios['runner@test.com']!;
  const device = await sembrarDispositivo(runner);

  // Las inscripciones van antes que los entrenamientos porque la carrera ya
  // corrida crea su propio workout colgado de su inscripcion.
  await sembrarInscripciones(runner);

  const workouts = await sembrarEntrenamientos(runner, device.id);
  await sembrarPlanActivo(runner, workouts);
  await sembrarZapatillas(
    runner,
    workouts.reduce((a, w) => a + w.distanceMeters, 0),
  );

  console.log(
    `\n✔ Seed completo. Entra con cualquiera de las tres cuentas y la contrasena ` +
      `${PASSWORD_DE_PRUEBA}\n`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });

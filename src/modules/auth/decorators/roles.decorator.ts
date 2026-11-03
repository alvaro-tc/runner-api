import { SetMetadata } from '@nestjs/common';
import type { NADIE, Permiso as ClavePermiso } from '../permisos';

export const PERMISOS_KEY = 'permisos';

/**
 * Exige permisos del catalogo (`src/modules/auth/permisos.ts`), todos los que
 * se pasen. Sin argumentos: basta con estar logueado — sirve para abrir un
 * metodo dentro de un controlador que exige algo a nivel de clase.
 *
 * `NADIE` es el candado por defecto de los controladores: no lo tiene ningun rol,
 * asi que un endpoint nuevo que se olvide su `@Permiso` no queda abierto.
 */
export const Permiso = (...permisos: (ClavePermiso | typeof NADIE)[]) => SetMetadata(PERMISOS_KEY, permisos);

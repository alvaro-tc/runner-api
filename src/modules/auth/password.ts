import * as argon2 from 'argon2';

/**
 * Parametros de argon2id.
 *
 * 64 MiB y 3 pasadas es la recomendacion de OWASP: caro para un atacante con
 * GPUs, imperceptible en un login (~100 ms). Aqui SI vale el coste, al reves
 * que en los refresh tokens, porque una contrasena humana si es atacable por
 * diccionario.
 *
 * Vive suelto y no dentro de `AuthService` porque hay un segundo sitio que crea
 * contrasenas: el panel de admin, cuando da de alta a alguien o le resetea la
 * suya. Dos juegos de parametros distintos significarian cuentas con hashes mas
 * baratos segun por donde entraron, que es justo el tipo de diferencia que
 * nadie audita hasta que duele.
 */
export const ARGON2_OPTS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
};

/** Hash de una contrasena, con los parametros de arriba. */
export function hashPassword(plano: string): Promise<string> {
  return argon2.hash(plano, ARGON2_OPTS);
}

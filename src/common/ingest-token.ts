import { createHash, randomBytes } from 'node:crypto';

/**
 * El token con el que un dispositivo manda posiciones a **una** sesion.
 *
 * Es opaco, de 256 bits, y en la base solo vive su hash. Mismo criterio que el
 * refresh token de auth: quien lea la tabla no puede mandar posiciones en
 * nombre de nadie.
 *
 * Se hashea con sha256 y no con argon2 porque esto no es una contrasena sino 32
 * bytes aleatorios: no hay diccionario que atacar, y la ingesta tiene que
 * verificarlo en cada lote —varias veces por minuto y por corredor—, donde
 * argon2 costaria cientos de milisegundos de CPU para no proteger de nada.
 */
export function nuevoIngestToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashIngestToken(token) };
}

export function hashIngestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Normalizacion de la cedula de identidad.
 *
 * El mismo documento se teclea de cinco maneras —`1234567`, `1234567 LP`,
 * `1234567-LP`, `1234567 lp`— y las cinco tienen que ser el mismo usuario: la
 * CI es credencial de acceso y clave de cruce con los pagos hechos desde la
 * web. Sin normalizar, la persona que se inscribe en la web con `1234567 LP` y
 * entra en la app con `1234567` son dos cuentas distintas.
 *
 * Se guarda **normalizada** y se busca **normalizada**: es lo unico que hace
 * util al indice unico de `users.ci`.
 */
export function normalizarCi(valor: string): string {
  return valor
    .toUpperCase()
    .replace(/[\s.\-_]/g, '')
    .trim();
}

/** Lo minimo para que sea una CI y no un dedazo. */
export function esCiValida(valor: string): boolean {
  return /^[0-9]{4,12}[A-Z]{0,3}$/.test(normalizarCi(valor));
}

/**
 * Que escribio el usuario en el campo unico de "usuario o correo".
 *
 * Se decide por el `@` y no preguntando a la base: un endpoint que responde
 * distinto segun si el valor existe es un comprobador gratuito de quien tiene
 * cuenta.
 */
export function esEmail(valor: string): boolean {
  return valor.includes('@');
}

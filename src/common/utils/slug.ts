/**
 * Nombre a slug: sin acentos, en minusculas y con guiones.
 *
 * La normalizacion NFD separa la letra de su tilde y el rango de combinantes la
 * borra, asi que "Maraton La Paz 3600" y "Maraton La Paz 3600" (con tilde) dan
 * el mismo slug. Lo que no hace es garantizar unicidad: de eso se encarga quien
 * lo use, consultando su propia tabla.
 */
export function aSlug(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140)
    .replace(/-+$/g, '');
}

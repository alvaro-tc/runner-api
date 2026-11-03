/**
 * Catalogo de permisos del panel, agrupado por modulo.
 *
 * Es codigo y no tabla a proposito: cada permiso corresponde a endpoints
 * concretos (`@Permiso(...)`), asi que uno nuevo solo tiene sentido junto con
 * el codigo que lo exige. Lo que si es dato son los **roles** (tabla `roles`):
 * que permisos tiene cada uno lo decide el panel.
 */
export const MODULOS = [
  {
    key: 'carreras',
    name: 'Carreras',
    description: 'Las maratones: datos, imágenes, cobro por QR y la largada en vivo.',
    permisos: [
      { key: 'carreras.ver', name: 'Ver carreras', description: 'Lista, detalle y mapa en vivo.' },
      { key: 'carreras.editar', name: 'Crear y editar', description: 'Crear, editar, publicar, largar y eliminar carreras.' },
    ],
  },
  {
    key: 'resumen',
    name: 'Resumen',
    description: 'Métricas de cada carrera: inscritas, recaudado, embudo.',
    permisos: [{ key: 'resumen.ver', name: 'Ver métricas', description: 'El tablero de resumen de cada carrera.' }],
  },
  {
    key: 'inscritas',
    name: 'Inscritas',
    description: 'Las personas inscritas en cada carrera.',
    permisos: [
      { key: 'inscritas.ver', name: 'Ver inscritas', description: 'Lista con nombre, CI, celular y dorsal.' },
      { key: 'inscritas.exportar', name: 'Exportar', description: 'Descargar el listado en CSV/Excel.' },
    ],
  },
  {
    key: 'cobros',
    name: 'Cobros',
    description: 'Pagos por QR y comprobantes.',
    permisos: [
      { key: 'cobros.ver', name: 'Ver cobros', description: 'Pagos, comprobantes y su exportación.' },
      { key: 'cobros.validar', name: 'Validar', description: 'Aprobar o rechazar comprobantes, confirmar y reembolsar.' },
    ],
  },
  {
    key: 'usuarios',
    name: 'Usuarios',
    description: 'Las cuentas de la plataforma.',
    permisos: [
      { key: 'usuarios.ver', name: 'Ver cuentas', description: 'Buscar y listar cuentas.' },
      { key: 'usuarios.gestionar', name: 'Gestionar corredoras', description: 'Crear, editar, cambiar contraseña y borrar cuentas de corredoras.' },
      { key: 'roles.asignar', name: 'Asignar roles', description: 'Dar cualquier rol (incluido admin) y gestionar cuentas del equipo.' },
    ],
  },
  {
    key: 'roles',
    name: 'Roles y permisos',
    description: 'Qué puede hacer cada rol.',
    permisos: [{ key: 'roles.gestionar', name: 'Gestionar roles', description: 'Crear, editar y borrar roles y su matriz de permisos.' }],
  },
  {
    key: 'auditoria',
    name: 'Auditoría',
    description: 'El registro de todo lo que se cambia desde el panel.',
    permisos: [{ key: 'auditoria.ver', name: 'Ver registro', description: 'Quién hizo qué, cuándo y con qué resultado.' }],
  },
  {
    key: 'plataforma',
    name: 'Plataforma',
    description: 'La API de pagos externa y quién valida los cobros de cada carrera.',
    permisos: [
      { key: 'plataforma.gestionar', name: 'Gestionar plataforma', description: 'Encender o apagar la API de pagos y asignar el validador de cada carrera.' },
    ],
  },
  {
    key: 'config',
    name: 'Configuración',
    description: 'Cargo por servicio, recorridos y la app Android.',
    permisos: [{ key: 'config.gestionar', name: 'Gestionar', description: 'Precios del servicio, recorridos y APK.' }],
  },
] as const;

export type Permiso = (typeof MODULOS)[number]['permisos'][number]['key'];

export const PERMISOS: readonly string[] = MODULOS.flatMap((m) => m.permisos.map((p) => p.key));

/** Claves de los roles de serie. El resto de roles se crean desde el panel. */
export const UserRole = { runner: 'runner', organizer: 'organizer', osi: 'osi', admin: 'admin', plataforma: 'plataforma', api: 'api' } as const;

/** La cuenta de sistema que firma lo que valida la API de pagos (ver migracion `pasarela_pagos`). */
export const USUARIO_API = 'api-pasarela';
export type UserRole = string;

/**
 * Candado de los controladores: ningun rol lo tiene (no esta en el catalogo),
 * asi que un endpoint que se olvide su `@Permiso` queda cerrado para todos.
 */
export const NADIE = 'nadie';

/**
 * Ningun rol tiene permisos implicitos, tampoco `admin`: todo lo que puede hacer
 * esta en la tabla y se puede revocar. Lo que evita quedarse sin quien
 * administre es una regla (ver `AdminService.noDejarSinGestor`), no un superusuario.
 */
export function permisosEfectivos(guardados: readonly string[] | undefined): string[] {
  return (guardados ?? []).filter((p) => PERMISOS.includes(p));
}

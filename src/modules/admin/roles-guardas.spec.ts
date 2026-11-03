import type { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { AdminService } from './admin.service';

/**
 * Las dos reglas que reemplazan al superusuario: nadie edita su propio rol, y
 * ningun cambio deja sin quien gestione roles. Si se rompen, nada falla a la
 * vista: alguien se da todos los permisos, o el panel queda sin dueño.
 */
describe('reglas de roles sin superusuario', () => {
  let roles: { key: string; permissions: string[] }[];
  let gestoresActivos: number;
  const update = jest.fn().mockResolvedValue({});
  const admin = Object.assign(Object.create(AdminService.prototype) as object, {
    permisos: { recargar: jest.fn(), de: () => [], tiene: () => false },
    logger: { log: jest.fn(), warn: jest.fn() },
    prisma: {
      role: {
        findUnique: ({ where }: { where: { key: string } }) => Promise.resolve(roles.find((r) => r.key === where.key) ?? null),
        findMany: () => Promise.resolve(roles),
        update,
      },
      user: { count: () => Promise.resolve(gestoresActivos) },
    },
  }) as unknown as AdminService;
  // listarRoles no importa aqui: se corta antes de pintar
  jest.spyOn(AdminService.prototype, 'listarRoles').mockResolvedValue({ modules: [], roles: [] } as never);

  beforeEach(() => {
    roles = [
      { key: 'osi', permissions: ['usuarios.ver', 'roles.gestionar'] },
      { key: 'admin', permissions: ['carreras.ver', 'carreras.editar'] },
    ];
    gestoresActivos = 1;
    update.mockClear();
  });

  const codigo = (p: Promise<unknown>) => p.then(() => null, (e: AppException) => e.code);

  it('nadie cambia los permisos de su propio rol', async () => {
    expect(await codigo(admin.editarRol('osi', { permissions: ['usuarios.ver', 'roles.gestionar', 'carreras.editar'] }, 'osi'))).toBe(ErrorCode.INSUFFICIENT_ROLE);
    expect(update).not.toHaveBeenCalled();
  });

  it('pero si puede renombrarlo', async () => {
    expect(await codigo(admin.editarRol('osi', { name: 'Seguridad' }, 'osi'))).toBeNull();
  });

  it('otra persona con roles.gestionar si puede recortarle permisos a admin', async () => {
    expect(await codigo(admin.editarRol('admin', { permissions: ['carreras.ver'] }, 'osi'))).toBeNull();
    expect(update).toHaveBeenCalled();
  });

  it('no deja quitar roles.gestionar si nadie mas lo tendria', async () => {
    gestoresActivos = 0;
    expect(await codigo(admin.editarRol('osi', { permissions: ['usuarios.ver'] }, 'admin'))).toBe(ErrorCode.CONFLICT);
    expect(update).not.toHaveBeenCalled();
  });

  it('si lo deja cuando otra persona lo conserva', async () => {
    gestoresActivos = 1;
    expect(await codigo(admin.editarRol('osi', { permissions: ['usuarios.ver'] }, 'admin'))).toBeNull();
  });
});

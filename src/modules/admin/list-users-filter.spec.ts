import { AdminService } from './admin.service';
import { UserRole } from '../../../generated/prisma/enums';
import type { ListUsersQueryDto } from './dto/admin.dto';

/**
 * El listado de usuarios del panel: filtro por rol, busqueda y paginacion.
 *
 * Se prueba la consulta que sale, no la base. Lo que se rompe en silencio aqui
 * es el filtro por rol: la pagina corta por fecha, asi que si el rol no llega
 * al `where`, los admins y organizadores —cuatro cuentas, de las primeras
 * creadas— desaparecen del panel en cuanto hay una pagina de corredores mas
 * nuevos. Nada falla; simplemente no estan.
 */
describe('listado de usuarios del panel', () => {
  const count = jest.fn().mockResolvedValue(7);
  const findMany = jest.fn().mockResolvedValue([]);
  const admin = Object.assign(Object.create(AdminService.prototype) as object, {
    prisma: {
      user: { count, findMany },
      // El servicio pide count y findMany en una transaccion; aqui basta con
      // resolver las dos promesas que le pasa.
      $transaction: (promesas: Promise<unknown>[]) => Promise.all(promesas),
    },
  }) as unknown as AdminService;

  beforeEach(() => {
    count.mockClear();
    findMany.mockClear();
  });

  const listar = (query: ListUsersQueryDto, actorRole?: UserRole) =>
    admin.listarUsuarios(query, actorRole);
  // El primer argumento de la primera llamada, tipado: con
  // noUncheckedIndexedAccess los indices salen posiblemente undefined.
  const primerArgumento = (mock: jest.Mock): Record<string, unknown> => {
    const args = (mock.mock.calls as Record<string, unknown>[][])[0];
    if (!args?.[0]) throw new Error('el mock no recibio argumentos');
    return args[0];
  };
  const consulta = () => primerArgumento(findMany);

  it('manda el rol al where, no lo filtra despues', async () => {
    await listar({ role: 'organizer' });
    expect(consulta().where).toEqual({ role: 'organizer' });
  });

  // El techo del organizador aplicado a mirar, no solo a editar. Si el rol del
  // actor no llega al `where`, un organizador se lista los admins con sus
  // correos: justo las cuentas que `techoDeOrganizador` le impide tocar.
  it('a un organizador solo le lista corredores, pida el rol que pida', async () => {
    await listar({ role: 'admin' }, UserRole.organizer);
    expect(consulta().where).toEqual({ role: 'runner' });
  });

  it('a un admin le respeta el filtro que pidio', async () => {
    await listar({ role: 'admin' }, UserRole.admin);
    expect(consulta().where).toEqual({ role: 'admin' });
  });

  it('cuenta con el mismo where con el que lista', async () => {
    await listar({ role: 'admin', q: 'ana' });
    expect(primerArgumento(count)).toEqual({ where: consulta().where });
  });

  it('busca en email, ci, nombre y celular', async () => {
    await listar({ q: '7654' });
    const where = consulta().where as { OR: Record<string, unknown>[] };
    expect(where.OR.map((c) => Object.keys(c)[0])).toEqual([
      'email',
      'ci',
      'name',
      'registrations',
    ]);
  });

  it('pagina: salta las anteriores y trae solo el tamano pedido', async () => {
    await listar({ page: 3, pageSize: 25 });
    expect(consulta()).toMatchObject({ skip: 50, take: 25 });
  });

  it('sin paginacion pedida, primera pagina de 20', async () => {
    await listar({});
    expect(consulta()).toMatchObject({ skip: 0, take: 20 });
  });

  it('devuelve el total para que el panel pinte "1-20 de N"', async () => {
    const pagina = await listar({ pageSize: 5 });
    expect(pagina).toMatchObject({ total: 7, page: 1, pageSize: 5 });
  });
});

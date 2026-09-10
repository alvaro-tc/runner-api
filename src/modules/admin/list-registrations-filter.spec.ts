import { AdminService, buscarInscripcion } from './admin.service';
import { RegistrationStatus } from '../../../generated/prisma/enums';

/**
 * El buscador de inscripciones del panel.
 *
 * Lo que se rompe en silencio aqui es la insensibilidad a mayusculas de los
 * campos de `personalData`: son jsonb, y el `mode` de Prisma es facil de
 * olvidar porque el filtro compila igual sin el. Sin `mode`, buscar "perez"
 * no encuentra a "Perez" y el admin concluye que la inscripcion no existe.
 */
describe('buscador de inscripciones del panel', () => {
  it('busca insensible a mayusculas en las columnas del usuario', () => {
    const ramas = buscarInscripcion('Perez');
    const usuario = ramas.filter((r) => 'user' in r);

    expect(usuario).toHaveLength(3);
    for (const rama of usuario) {
      expect(Object.values(rama.user as object)[0]).toEqual({
        contains: 'Perez',
        mode: 'insensitive',
      });
    }
  });

  it('busca insensible a mayusculas tambien dentro de personalData', () => {
    const json = buscarInscripcion('perez').filter((r) => 'personalData' in r);

    expect(json.map((r) => (r.personalData as { path: string[] }).path[0])).toEqual([
      'fullName',
      'docId',
      'phone',
    ]);
    for (const rama of json) {
      expect(rama.personalData).toMatchObject({ string_contains: 'perez', mode: 'insensitive' });
    }
  });
});

describe('listado de inscripciones del panel', () => {
  const count = jest.fn().mockResolvedValue(3);
  const findMany = jest.fn().mockResolvedValue([]);
  const admin = Object.assign(Object.create(AdminService.prototype) as object, {
    prisma: { registration: { count, findMany } },
  }) as unknown as AdminService;

  beforeEach(() => {
    count.mockClear();
    findMany.mockClear();
  });

  const consulta = () => {
    const args = (findMany.mock.calls as Record<string, unknown>[][])[0];
    if (!args?.[0]) throw new Error('el mock no recibio argumentos');
    return args[0];
  };

  it('sin busqueda no mete un OR vacio en el where', async () => {
    await admin.listarInscripciones({ status: RegistrationStatus.confirmed });
    expect(consulta().where).toEqual({ deletedAt: null, status: RegistrationStatus.confirmed });
  });

  it('cuenta con el mismo where con el que lista', async () => {
    await admin.listarInscripciones({ search: 'ana' });
    const args = (count.mock.calls as Record<string, unknown>[][])[0];
    expect(args?.[0]).toEqual({ where: consulta().where });
  });

  it('pagina: salta las anteriores y trae solo el tamano pedido', async () => {
    await admin.listarInscripciones({ page: 3, limit: 25 });
    expect(consulta()).toMatchObject({ skip: 50, take: 25 });
  });

  it('devuelve el total y las paginas para que el panel pinte el paginador', async () => {
    const pagina = await admin.listarInscripciones({ limit: 2 });
    expect(pagina.meta).toEqual({ total: 3, page: 1, limit: 2, totalPages: 2 });
  });
});

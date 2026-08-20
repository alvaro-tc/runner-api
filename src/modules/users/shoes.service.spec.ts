import { ShoesService, toDto } from './shoes.service';
import type { PrismaService } from '../../database/prisma.service';

/**
 * Lo que importa probar aqui no es el CRUD (eso lo cubre el e2e contra Postgres)
 * sino las dos reglas que el usuario nota si se rompen: que solo haya una
 * zapatilla principal, y que retirar una la saque de ese puesto.
 */
describe('ShoesService', () => {
  const zapatillaBase = {
    id: 'z1',
    brand: 'Asics',
    model: 'Nimbus 26',
    distanceMeters: 0,
    alertThresholdMeters: 800_000,
    isPrimary: false,
    retiredAt: null as Date | null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  function construir(overrides: Partial<typeof zapatillaBase> = {}) {
    const shoe = {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation(({ data }: { data: object }) => ({
        ...zapatillaBase,
        ...data,
      })),
      update: jest.fn().mockImplementation(({ data }: { data: object }) => ({
        ...zapatillaBase,
        ...overrides,
        ...data,
      })),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findFirst: jest.fn().mockResolvedValue({ ...zapatillaBase, ...overrides }),
      delete: jest.fn().mockResolvedValue({ ...zapatillaBase, ...overrides }),
    };

    const prisma = {
      shoe,
      $transaction: (cb: (tx: unknown) => unknown) => cb({ shoe }),
    } as unknown as PrismaService;

    return { service: new ShoesService(prisma), shoe };
  }

  describe('create', () => {
    it('marca principal la primera zapatilla en uso, sin que el cliente lo pida', async () => {
      const { service } = construir();

      const creada = await service.create('u1', { brand: 'Asics', model: 'Nimbus 26' });

      expect(creada.isPrimary).toBe(true);
    });

    it('no marca principal la segunda si el cliente no lo pide', async () => {
      const { service, shoe } = construir();
      shoe.count.mockResolvedValue(2);

      const creada = await service.create('u1', { brand: 'Nike', model: 'Pegasus' });

      expect(creada.isPrimary).toBe(false);
      expect(shoe.updateMany).not.toHaveBeenCalled();
    });

    it('al crear una principal desmarca la anterior en la misma transaccion', async () => {
      const { service, shoe } = construir();
      shoe.count.mockResolvedValue(1);

      await service.create('u1', { brand: 'Nike', model: 'Pegasus', isPrimary: true });

      expect(shoe.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', isPrimary: true },
        data: { isPrimary: false },
      });
    });
  });

  describe('update', () => {
    it('retirar una zapatilla la saca de principal', async () => {
      const { service } = construir({ isPrimary: true });

      const actualizada = await service.update('u1', 'z1', { retired: true });

      expect(actualizada.isPrimary).toBe(false);
      expect(actualizada.retiredAt).not.toBeNull();
    });

    it('retirar manda sobre isPrimary si llegan los dos juntos', async () => {
      const { service } = construir();

      const actualizada = await service.update('u1', 'z1', { retired: true, isPrimary: true });

      expect(actualizada.isPrimary).toBe(false);
    });

    it('marcar principal una retirada la vuelve a poner en uso', async () => {
      const { service } = construir({ retiredAt: new Date('2026-02-01T00:00:00Z') });

      const actualizada = await service.update('u1', 'z1', { isPrimary: true });

      expect(actualizada.isPrimary).toBe(true);
      expect(actualizada.retiredAt).toBeNull();
    });

    it('no mueve la fecha de retiro al re-retirar una ya retirada', async () => {
      const retiradaEl = new Date('2026-02-01T00:00:00Z');
      const { service } = construir({ retiredAt: retiradaEl });

      const actualizada = await service.update('u1', 'z1', { retired: true });

      expect(actualizada.retiredAt).toBe(retiradaEl.toISOString());
    });

    it('404 cuando la zapatilla es de otro usuario', async () => {
      const { service, shoe } = construir();
      shoe.findFirst.mockResolvedValue(null);

      await expect(service.update('u1', 'ajena', { brand: 'X' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('sumarDistancia', () => {
    /** `findFirst` devuelve el estado ANTERIOR; `update`, el posterior. */
    function conKilometros(antes: number, sumar: number) {
      const { service, shoe } = construir({ isPrimary: true, distanceMeters: antes });
      shoe.findFirst.mockResolvedValue({
        ...zapatillaBase,
        isPrimary: true,
        distanceMeters: antes,
      });
      shoe.update.mockResolvedValue({
        ...zapatillaBase,
        isPrimary: true,
        distanceMeters: antes + sumar,
      });

      return { service, shoe };
    }

    it('avisa la vez que cruza el umbral', async () => {
      const { service, shoe } = conKilometros(799_000, 5_000);

      const sumada = await service.sumarDistancia({ shoe } as never, 'u1', 5_000);

      expect(sumada?.wearAlert).toBe(true);
      expect(sumada?.justCrossedWearAlert).toBe(true);
    });

    it('NO vuelve a avisar en los entrenamientos siguientes', async () => {
      const { service, shoe } = conKilometros(805_000, 5_000);

      const sumada = await service.sumarDistancia({ shoe } as never, 'u1', 5_000);

      // El umbral sigue superado, pero ya se aviso: repetirlo en cada salida es
      // lo que hace que el usuario apague los push para siempre.
      expect(sumada?.wearAlert).toBe(true);
      expect(sumada?.justCrossedWearAlert).toBe(false);
    });

    it('sin zapatilla principal no pasa nada', async () => {
      const { service, shoe } = construir();
      shoe.findFirst.mockResolvedValue(null);

      await expect(service.sumarDistancia({ shoe } as never, 'u1', 5_000)).resolves.toBeNull();
    });
  });

  describe('toDto', () => {
    it('calcula el desgaste como fraccion del umbral', () => {
      const dto = toDto({ ...zapatillaBase, distanceMeters: 248_000 });

      expect(dto.wearRatio).toBe(0.31);
      expect(dto.wearAlert).toBe(false);
    });

    it('avisa justo al alcanzar el umbral, no al pasarlo', () => {
      const dto = toDto({ ...zapatillaBase, distanceMeters: 800_000 });

      expect(dto.wearRatio).toBe(1);
      expect(dto.wearAlert).toBe(true);
    });
  });
});

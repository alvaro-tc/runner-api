import { Test } from '@nestjs/testing';
import { DatabaseModule } from '../src/database/database.module';
import { AppConfigModule } from '../src/config/config.module';
import { PrismaService } from '../src/database/prisma.service';

/**
 * Verifica lo que el esquema promete y Prisma NO garantiza por si solo: que
 * `positions` este realmente particionada y enrute filas, que el dedupe por
 * `clientPointId` funcione, y que el email sea insensible a mayusculas.
 *
 * Necesita Postgres levantado con la migracion aplicada.
 */
describe('Esquema de datos (e2e)', () => {
  let prisma: PrismaService;
  const marca = `test-${Date.now()}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: marca } } });
    await prisma.$disconnect();
  });

  it('positions es una tabla particionada por rango sobre recordedAt', async () => {
    const [row] = await prisma.$queryRaw<{ relkind: string; partkey: string | null }[]>`
      SELECT relkind::text, pg_get_partkeydef(oid) AS partkey
      FROM pg_class WHERE relname = 'positions'
    `;

    expect(row?.relkind).toBe('p'); // 'p' = partitioned table
    expect(row?.partkey).toBe('RANGE ("recordedAt")');
  });

  it('existe una particion por mes mas la de respaldo', async () => {
    const [conteo] = await prisma.$queryRaw<{ total: bigint }[]>`
      SELECT count(*) AS total FROM pg_inherits WHERE inhparent = 'positions'::regclass
    `;
    expect(Number(conteo?.total ?? 0)).toBeGreaterThanOrEqual(13);

    const [defecto] = await prisma.$queryRaw<{ relname: string }[]>`
      SELECT relname FROM pg_class WHERE relname = 'positions_default'
    `;
    expect(defecto?.relname).toBe('positions_default');
  });

  it('crear la particion de un mes es idempotente', async () => {
    const fecha = new Date('2029-03-15T00:00:00Z');

    const primera = await prisma.ensurePositionsPartition(fecha);
    const segunda = await prisma.ensurePositionsPartition(fecha);

    expect(primera).toContain('positions_2029_03');
    expect(segunda).toContain('ya existia');

    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS positions_2029_03');
  });

  it('una posicion aterriza en la particion de SU mes, no en otra', async () => {
    const user = await prisma.user.create({
      data: { email: `particion.${marca}@test.com`, passwordHash: 'x', name: 'Particion' },
    });
    const recordedAt = new Date('2026-05-17T10:30:00Z');

    await prisma.position.create({
      data: {
        trackingSessionId: 'sesion-ficticia',
        userId: user.id,
        recordedAt,
        lat: -16.5,
        lng: -68.15,
        clientPointId: `${marca}-p1`,
      },
    });

    // `tableoid` delata en que particion fisica quedo la fila.
    const [fila] = await prisma.$queryRaw<{ particion: string }[]>`
      SELECT tableoid::regclass::text AS particion
      FROM positions WHERE "clientPointId" = ${`${marca}-p1`}
    `;

    expect(fila?.particion).toBe('positions_2026_05');
  });

  it('reenviar el mismo punto no lo duplica', async () => {
    const user = await prisma.user.create({
      data: { email: `dedupe.${marca}@test.com`, passwordHash: 'x', name: 'Dedupe' },
    });
    const punto = {
      trackingSessionId: 'sesion-ficticia',
      userId: user.id,
      recordedAt: new Date('2026-06-01T08:00:00Z'),
      lat: -16.5,
      lng: -68.15,
      clientPointId: `${marca}-dup`,
    };

    // `skipDuplicates` es el ON CONFLICT DO NOTHING que usara la ingesta por lotes.
    const primero = await prisma.position.createMany({ data: [punto] });
    const reintento = await prisma.position.createMany({ data: [punto], skipDuplicates: true });

    expect(primero.count).toBe(1);
    expect(reintento.count).toBe(0);
    expect(await prisma.position.count({ where: { clientPointId: `${marca}-dup` } })).toBe(1);
  });

  it('el email no distingue mayusculas (citext)', async () => {
    const email = `Mayus.${marca}@Test.com`;
    await prisma.user.create({ data: { email, passwordHash: 'x', name: 'Mayus' } });

    const encontrado = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    expect(encontrado).not.toBeNull();

    await expect(
      prisma.user.create({ data: { email: email.toUpperCase(), passwordHash: 'x', name: 'Otro' } }),
    ).rejects.toThrow();
  });

  it('borrar el usuario arrastra sus posiciones en cascada', async () => {
    const user = await prisma.user.create({
      data: { email: `cascada.${marca}@test.com`, passwordHash: 'x', name: 'Cascada' },
    });
    await prisma.position.create({
      data: {
        trackingSessionId: 'sesion-ficticia',
        userId: user.id,
        recordedAt: new Date('2026-07-02T08:00:00Z'),
        lat: -16.5,
        lng: -68.15,
        clientPointId: `${marca}-casc`,
      },
    });

    await prisma.user.delete({ where: { id: user.id } });

    expect(await prisma.position.count({ where: { userId: user.id } })).toBe(0);
  });

  it('el dorsal es unico dentro de una maraton', async () => {
    const user = await prisma.user.create({
      data: { email: `dorsal.${marca}@test.com`, passwordHash: 'x', name: 'Dorsal' },
    });
    const marathon = await prisma.marathon.create({
      data: {
        slug: `maraton-${marca}`,
        name: 'Maraton de prueba',
        startsAt: new Date('2027-01-01T11:00:00Z'),
        city: 'La Paz',
        distanceMeters: 42195,
        capacity: 100,
        priceCents: 15000,
      },
    });

    await prisma.registration.create({
      data: { userId: user.id, marathonId: marathon.id, bibNumber: '0001' },
    });

    await expect(
      prisma.registration.create({
        data: { userId: user.id, marathonId: marathon.id, bibNumber: '0001' },
      }),
    ).rejects.toThrow();

    await prisma.marathon.delete({ where: { id: marathon.id } });
  });
});

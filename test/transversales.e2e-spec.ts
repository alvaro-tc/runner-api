import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';

interface Envelope<T> {
  data: T;
}

interface AppInfo {
  currency: string;
  minAppVersion: string;
  deepLinkScheme: string;
  serviceFee: { label: string } | null;
  features: { gpsSimulation: boolean; socialLogin: boolean };
}

/**
 * `GET /config/app` y las paginas de `/links/*`.
 *
 * Lo que importa aqui no es el HTML —eso lo cubre `link-page.spec.ts`— sino que
 * las dos cosas sean **publicas** y que una maraton sin publicar no se filtre
 * por un enlace compartido.
 */
describe('Transversales (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const marca = `links-${Date.now()}`;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);

    await prisma.marathon.createMany({
      data: [
        {
          slug: `${marca}-publicada`,
          name: 'Maraton "Nocturna" & Trail <2026>',
          startsAt: new Date('2026-12-06T13:00:00Z'),
          city: 'La Paz',
          distanceMeters: 21_097,
          capacity: 500,
          priceCents: 18_000,
          publishedAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          slug: `${marca}-embargada`,
          name: 'Todavia no anunciada',
          startsAt: new Date('2026-12-20T13:00:00Z'),
          city: 'Sucre',
          distanceMeters: 10_000,
          capacity: 300,
          priceCents: 12_000,
          publishedAt: null,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.marathon.deleteMany({ where: { slug: { contains: marca } } });
    await app?.close();
  });

  describe('GET /config/app', () => {
    it('es publico y trae las constantes del entorno', async () => {
      const res = await http().get('/api/v1/config/app').expect(200);

      const { data } = res.body as Envelope<AppInfo>;
      expect(data.currency).toBe('BOB');
      expect(data.minAppVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(data.deepLinkScheme).toBe('paceup');
      // Los botones sociales siguen siendo UI: el backend lo dice, no la app.
      expect(data.features.socialLogin).toBe(false);
    });

    it('el cargo por servicio viaja como ausencia cuando esta apagado', async () => {
      const global = await prisma.serviceFeeConfig.findFirst({ where: { scope: 'global' } });

      const res = await http().get('/api/v1/config/app').expect(200);
      const { data } = res.body as Envelope<AppInfo>;

      // `null`, nunca `{ enabled: false }` ni un importe en cero: la UI no debe
      // pintar una linea de "Bs 0,00".
      if (global?.enabled) expect(data.serviceFee).toEqual({ label: global.label });
      else expect(data.serviceFee).toBeNull();
    });
  });

  describe('GET /links/*', () => {
    it('devuelve HTML publico con Open Graph y el salto a la app', async () => {
      const res = await http().get(`/api/v1/links/marathon/${marca}-publicada`).expect(200);

      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('property="og:title"');
      expect(res.text).toContain(`paceup://marathon/${marca}-publicada`);
      // El nombre trae comillas y angulos a proposito: tienen que salir escapados.
      expect(res.text).not.toContain('<2026>');
      expect(res.text).toContain('&lt;2026&gt;');
    });

    it('trae su propia CSP con nonce, para que el inline no quede bloqueado', async () => {
      const res = await http().get(`/api/v1/links/marathon/${marca}-publicada`).expect(200);

      const csp = res.headers['content-security-policy'] ?? '';
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];

      expect(nonce).toBeDefined();
      expect(res.text).toContain(`<script nonce="${nonce ?? ''}">`);
    });

    it('una maraton sin publicar no se filtra por un enlace', async () => {
      await http().get(`/api/v1/links/marathon/${marca}-embargada`).expect(404);
    });

    it('un enlace inexistente da una pagina que no salta a ningun lado', async () => {
      const res = await http().get('/api/v1/links/workout/no-existe').expect(404);

      expect(res.text).not.toContain('<script');
    });
  });
});

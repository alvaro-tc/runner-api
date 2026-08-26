import 'reflect-metadata';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import { dump } from 'js-yaml';
import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/config/app-config.service';
import { buildOpenApiDocument } from '../src/swagger';

/**
 * Vuelca el mismo contrato que sirve /api/docs a `api/openapi.yaml`, versionado
 * en el repo, para que Flutter arranque contra el contrato sin levantar el
 * backend. Correr con `npm run openapi:export`.
 */
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api/v1', {
    exclude: ['health', 'ready', { path: 'admin', method: RequestMethod.GET }],
  });

  const config = app.get(AppConfigService);
  const document = buildOpenApiDocument(app, config);
  await app.close();

  const outPath = resolve(__dirname, '../api/openapi.yaml');
  await writeFile(outPath, dump(document, { noRefs: true, lineWidth: 100 }), 'utf8');
  // eslint-disable-next-line no-console
  console.log(`Contrato escrito en ${outPath}`);
}

void main();

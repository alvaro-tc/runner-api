import { randomUUID } from 'node:crypto';
import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { paginaDeEnlace, paginaNoEncontrada } from './link-page';
import { LinksService, type TipoDeEnlace } from './links.service';

/**
 * Enlaces profundos: paginas HTML, no endpoints JSON.
 *
 * Viven bajo `/api/v1` como el resto para no inventar un segundo dominio de
 * rutas, pero no participan del sobre `{ data, meta }`: lo que devuelven lo
 * consumen WhatsApp y el navegador del telefono, no la app. Por eso se
 * escriben con `@Res()`, que deja el interceptor del sobre fuera de juego.
 *
 * Quedan fuera de Swagger a proposito: documentar una pagina HTML en un
 * catalogo de API JSON solo suma ruido. Su formato esta en `docs/api.md`.
 */
@ApiExcludeController()
@Controller('links')
export class LinksController {
  constructor(private readonly links: LinksService) {}

  @Get('marathon/:slug')
  @Public()
  marathon(@Param('slug') slug: string, @Res() res: Response): Promise<void> {
    return this.responder('marathon', slug, res);
  }

  @Get('workout/:id')
  @Public()
  workout(@Param('id') id: string, @Res() res: Response): Promise<void> {
    return this.responder('workout', id, res);
  }

  @Get('race/:registrationId')
  @Public()
  race(@Param('registrationId') id: string, @Res() res: Response): Promise<void> {
    return this.responder('race', id, res);
  }

  private async responder(tipo: TipoDeEnlace, id: string, res: Response): Promise<void> {
    const nonce = randomUUID();
    const datos = await this.links.resolver(tipo, id);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Sustituye a la CSP de helmet solo en esta respuesta: el `<style>` y el
    // `<script>` son inline y llevan este nonce. Todo lo demas se cierra —
    // `default-src 'none'` — porque esta pagina no carga nada de nadie salvo la
    // imagen de previsualizacion.
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; ` +
        `img-src https: http: data:; base-uri 'none'; form-action 'none'`,
    );

    if (!datos) {
      // Cache corto igual: un enlace roto que se comparte en un grupo se pide
      // muchas veces seguidas, y son todas la misma consulta fallida.
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.status(404).send(paginaNoEncontrada(this.links.canonical(tipo, id), nonce));
      return;
    }

    // Cinco minutos: lo suficiente para absorber la rafaga de bots que rascan
    // la previsualizacion cuando el enlace se pega en un grupo, y lo bastante
    // corto para que un cambio en la carrera se vea el mismo dia.
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(paginaDeEnlace({ ...datos, nonce }));
  }
}

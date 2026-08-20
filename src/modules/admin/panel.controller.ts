import { randomBytes } from 'node:crypto';
import { Controller, Get, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { SkipEnvelope } from '../../common/decorators/skip-envelope.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { panelHtml } from './panel.page';

/**
 * CSP propia del panel.
 *
 * La global de helmet trae `script-src 'self'`, que para el resto de la API
 * esta bien —no sirve HTML— pero deja el panel muerto: su unico script es
 * inline y el navegador lo descarta sin ejecutarlo, asi que la pagina se queda
 * sin estilos aplicados por JS, sin pestanas y sin formulario. En vez de abrir
 * `'unsafe-inline'` para todo el dominio, esta ruta manda la suya con un nonce
 * distinto en cada peticion: solo se ejecuta el bloque que sirve el servidor.
 *
 * `style-src-attr` va aparte porque el nonce no aplica a los atributos
 * `style="..."` del marcado; un atributo de estilo no ejecuta codigo.
 */
function cspDelPanel(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    // Todas las llamadas del panel van a /api/v1 del mismo origen.
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Sirve el panel en `/admin`.
 *
 * **`@Public()` no significa abierto.** Lo que se sirve aqui es HTML sin un solo
 * dato dentro: la pagina pide credenciales, saca un token y a partir de ahi todo
 * pasa por `/api/v1/admin/*`, que si exige rol `admin`. Poner un guard sobre el
 * HTML solo conseguiria que el navegador —que no manda cabeceras `Authorization`
 * al pedir una pagina— recibiera un 401 en vez del formulario de entrada.
 *
 * Vive fuera del prefijo `/api/v1` (ver `main.ts`): es una pagina, no un
 * endpoint, y no tiene sentido que una `/api/v2` cambie la URL del panel.
 */
@ApiExcludeController()
@Public()
// Sin esto el interceptor global devuelve {"data":"<!doctype html>..."} con
// todo el marcado escapado: el navegador pinta el texto pero descarta el
// <style> y el <script> porque sus nonce ya no coinciden con la cabecera CSP.
@SkipEnvelope()
@Controller('admin')
export class PanelController {
  @Get()
  // Las cabeceras se ponen a mano y no con @Header: la CSP depende del nonce,
  // que cambia en cada peticion.
  panel(@Res({ passthrough: true }) res: Response): string {
    const nonce = randomBytes(16).toString('base64');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // La pagina cambia con cada despliegue y pesa poco: cachearla solo
    // conseguiria que un admin siguiera viendo el panel viejo despues de
    // arreglarlo. Ademas el nonce cacheado seria un nonce reutilizado.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', cspDelPanel(nonce));

    return panelHtml(nonce);
  }
}

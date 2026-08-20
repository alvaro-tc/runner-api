import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { PANEL_HTML } from './panel.page';

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
@Controller('admin')
export class PanelController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  // La pagina cambia con cada despliegue y pesa poco: cachearla solo conseguiria
  // que un admin siguiera viendo el panel viejo despues de arreglarlo.
  @Header('Cache-Control', 'no-store')
  panel(): string {
    return PANEL_HTML;
  }
}

import { SetMetadata } from '@nestjs/common';

export const SKIP_ENVELOPE_KEY = 'skipEnvelope';

/**
 * Marca una ruta cuya respuesta NO debe envolverse en `{ data, meta }`.
 *
 * El envoltorio es global porque casi todo lo que sirve esta API es JSON para el
 * cliente movil. Lo excepcional es devolver otra cosa —el HTML del panel—, y ahi
 * envolver es peor que inutil: el controlador ya ha fijado `Content-Type:
 * text/html`, asi que el navegador recibe un documento que empieza por
 * `{"data":"<!doctype html>\n...` con todo el marcado escapado. No falla de forma
 * ruidosa: se ve el texto, pero los atributos `nonce=\"...\"` ya no coinciden con
 * la cabecera CSP y el navegador descarta el `<style>` y el `<script>`. El
 * sintoma es una pagina sin estilos y sin login, no un error.
 */
export const SkipEnvelope = () => SetMetadata(SKIP_ENVELOPE_KEY, true);

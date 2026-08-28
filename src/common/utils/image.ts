import { HttpStatus, Logger } from '@nestjs/common';
import sharp from 'sharp';
import type { Sharp } from 'sharp';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';

/**
 * Formatos que sabemos decodificar. Todo sale convertido a WebP igual.
 *
 * Extraido de `AvatarService` y `PaymentProofService` al aparecer un tercer
 * consumidor (`AdminService.subirQr`), tal como quedo anotado en el segundo.
 */
const FORMATOS_ACEPTADOS = new Set(['jpeg', 'jpg', 'png', 'webp', 'avif', 'gif', 'heif', 'tiff']);

/** Tope de pixeles antes de redimensionar, contra las "decompression bombs". */
const MAX_PIXELES = 50_000_000;

const logger = new Logger('ImagenWebp');

/**
 * Valida y reencoda una imagen subida a WebP.
 *
 * El tipo real se decide **decodificando**, no por `Content-Type` ni por la
 * extension: los dos los escribe el cliente. Reencodar de paso tira el EXIF.
 *
 * Todo fallo de sharp sale como `INVALID_IMAGE` (415) y **ninguno** escapa como
 * excepcion cruda: `sharp(buffer)` tira de forma sincrona con un buffer vacio o
 * ausente ("Input Buffer is empty"), y construirlo fuera del `try` convertia una
 * subida mala en un 500 sin rastro en el log. El motivo real de sharp va a
 * `details` —habla de la imagen, no de nuestras tripas— para que el panel diga
 * algo mas util que "ocurrio un error inesperado".
 */
export async function reencodarImagenAWebp(
  buffer: Buffer,
  opts: { maxWidthPx?: number; quality?: number } = {},
): Promise<Buffer> {
  if (!buffer || buffer.byteLength === 0) {
    throw imagenInvalida('El archivo llego vacio');
  }

  let imagen: Sharp;
  let formato: string | undefined;
  try {
    imagen = sharp(buffer, { failOn: 'error', limitInputPixels: MAX_PIXELES });
    formato = (await imagen.metadata()).format;
  } catch (error) {
    throw imagenInvalida(motivo(error, 'no se pudo leer'));
  }

  if (!formato || !FORMATOS_ACEPTADOS.has(formato)) {
    throw imagenInvalida(`Formato no admitido: ${formato ?? 'desconocido'}`);
  }

  try {
    return await imagen
      .rotate()
      .resize(
        opts.maxWidthPx ? { width: opts.maxWidthPx, withoutEnlargement: true } : undefined,
      )
      .webp({ quality: opts.quality ?? 90 })
      .toBuffer();
  } catch (error) {
    throw imagenInvalida(motivo(error, 'no se pudo convertir a WebP'));
  }
}

/** El texto de sharp, o algo legible si lo que llego no era un Error. */
function motivo(error: unknown, porDefecto: string): string {
  const texto = error instanceof Error ? error.message : String(error);
  return texto.trim() || porDefecto;
}

function imagenInvalida(detalle: string): AppException {
  // El log deja el motivo tecnico junto al requestId; sin esto, un `catch`
  // mudo obligaba a adivinar por que fallo una subida en produccion.
  logger.warn(`Imagen rechazada: ${detalle}`);

  return new AppException(
    ErrorCode.INVALID_IMAGE,
    'El archivo no es una imagen valida (JPEG, PNG, WebP, AVIF, GIF o HEIF)',
    HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    [detalle],
  );
}

import { HttpStatus } from '@nestjs/common';
import sharp from 'sharp';
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

/**
 * Valida y reencoda una imagen subida a WebP.
 *
 * El tipo real se decide **decodificando**, no por `Content-Type` ni por la
 * extension: los dos los escribe el cliente. Reencodar de paso tira el EXIF.
 */
export async function reencodarImagenAWebp(
  buffer: Buffer,
  opts: { maxWidthPx?: number; quality?: number } = {},
): Promise<Buffer> {
  const imagen = sharp(buffer, { failOn: 'error', limitInputPixels: MAX_PIXELES });

  let formato: string | undefined;
  try {
    formato = (await imagen.metadata()).format;
  } catch {
    throw imagenInvalida();
  }

  if (!formato || !FORMATOS_ACEPTADOS.has(formato)) throw imagenInvalida();

  try {
    return await imagen
      .rotate()
      .resize(
        opts.maxWidthPx ? { width: opts.maxWidthPx, withoutEnlargement: true } : undefined,
      )
      .webp({ quality: opts.quality ?? 90 })
      .toBuffer();
  } catch {
    throw imagenInvalida();
  }
}

function imagenInvalida(): AppException {
  return new AppException(
    ErrorCode.INVALID_IMAGE,
    'El archivo no es una imagen valida (JPEG, PNG, WebP, AVIF, GIF o HEIF)',
    HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  );
}

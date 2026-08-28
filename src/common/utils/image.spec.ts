import sharp from 'sharp';
import { HttpStatus } from '@nestjs/common';
import { reencodarImagenAWebp } from './image';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';

/**
 * Lo que se protege aqui es que **ningun** archivo raro escape como excepcion
 * cruda: `sharp()` tira de forma sincrona con un buffer vacio o ausente, y
 * construirlo fuera del `try` convertia una subida mala en un 500 opaco (el
 * fallo real que se vio subiendo el afiche de una maraton).
 */
describe('reencodarImagenAWebp', () => {
  const esperarImagenInvalida = async (entrada: Buffer) => {
    await expect(reencodarImagenAWebp(entrada, { maxWidthPx: 1600 })).rejects.toMatchObject({
      code: ErrorCode.INVALID_IMAGE,
    });

    const error = await reencodarImagenAWebp(entrada).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).getStatus()).toBe(HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    // El motivo tecnico viaja en `details`: sin el, el panel solo podia decir
    // "ocurrio un error inesperado".
    expect((error as AppException).details).toHaveLength(1);
  };

  it('convierte un JPEG grande y lo reescala al ancho pedido', async () => {
    const jpeg = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: '#334455' },
    })
      .jpeg()
      .toBuffer();

    const webp = await reencodarImagenAWebp(jpeg, { maxWidthPx: 1600 });
    const meta = await sharp(webp).metadata();

    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(1600);
  });

  it('rechaza un archivo vacio como imagen invalida, no como error interno', async () => {
    await esperarImagenInvalida(Buffer.alloc(0));
  });

  it('rechaza un buffer ausente', async () => {
    await esperarImagenInvalida(undefined as unknown as Buffer);
  });

  it('rechaza algo que no es una imagen', async () => {
    await esperarImagenInvalida(Buffer.from('esto es un PDF, no una imagen'));
  });
});

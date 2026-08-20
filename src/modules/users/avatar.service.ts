import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { StorageService } from '../storage/storage.service';

/**
 * Formatos que aceptamos que **entren**. Todo sale convertido a WebP igual, asi
 * que la lista solo dice que sabemos decodificar. Se excluye SVG a proposito:
 * es XML ejecutable y servirlo desde nuestro dominio es un XSS de manual.
 */
const FORMATOS_ACEPTADOS = new Set(['jpeg', 'jpg', 'png', 'webp', 'avif', 'gif', 'heif', 'tiff']);

/** Tope de pixeles antes de redimensionar, contra las "decompression bombs". */
const MAX_PIXELES = 50_000_000;

@Injectable()
export class AvatarService {
  private readonly logger = new Logger(AvatarService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Procesa y reemplaza el avatar.
   *
   * El tipo real se decide **decodificando la imagen**, no leyendo el
   * `Content-Type` ni la extension: los dos los escribe el cliente y los dos se
   * falsifican en dos segundos. Si sharp no la abre, no es una imagen.
   *
   * Ademas nunca se guarda el archivo original: se reencoda a WebP. Eso tira de
   * paso los metadatos EXIF, que en una foto de telefono llevan las coordenadas
   * GPS de donde se tomo. Un avatar no deberia publicar la casa de nadie.
   */
  async replace(userId: string, archivo: { buffer: Buffer; size: number }): Promise<string> {
    const maximo = this.config.get('AVATAR_MAX_BYTES');
    if (archivo.size > maximo) {
      throw new AppException(
        ErrorCode.FILE_TOO_LARGE,
        `La imagen supera el maximo de ${Math.round(maximo / 1024 / 1024)} MB`,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    const lado = this.config.get('AVATAR_SIZE_PX');
    const webp = await this.procesar(archivo.buffer, lado);

    const clave = `avatars/${userId}/${randomUUID()}.webp`;
    const anterior = await this.prisma.userProfile
      .findUnique({ where: { userId }, select: { avatarUrl: true } })
      .then((p) => p?.avatarUrl ?? null);

    await this.storage.save(clave, webp);
    await this.prisma.userProfile.upsert({
      where: { userId },
      create: { userId, avatarUrl: clave },
      update: { avatarUrl: clave },
    });

    // Solo despues de que la fila apunta al nuevo archivo. Al reves, un fallo
    // en el update dejaria al usuario sin avatar y sin forma de recuperarlo.
    if (anterior) await this.storage.delete(anterior);

    return this.storage.url(clave);
  }

  async remove(userId: string): Promise<void> {
    const perfil = await this.prisma.userProfile.findUnique({
      where: { userId },
      select: { avatarUrl: true },
    });

    if (!perfil?.avatarUrl) return;

    await this.prisma.userProfile.update({ where: { userId }, data: { avatarUrl: null } });
    await this.storage.delete(perfil.avatarUrl);
  }

  private async procesar(buffer: Buffer, lado: number): Promise<Buffer> {
    // `failOn: 'error'` hace que sharp rechace archivos corruptos en vez de
    // devolver medio pixel; `limitInputPixels` corta las bombas de compresion.
    const imagen = sharp(buffer, { failOn: 'error', limitInputPixels: MAX_PIXELES });

    let formato: string | undefined;
    try {
      formato = (await imagen.metadata()).format;
    } catch (error) {
      this.logger.debug(`Avatar rechazado: ${(error as Error).message}`);
      throw this.noEsImagen();
    }

    if (!formato || !FORMATOS_ACEPTADOS.has(formato)) {
      throw this.noEsImagen();
    }

    try {
      return await imagen
        .rotate() // aplica la orientacion EXIF antes de recortar, o sale girado
        .resize(lado, lado, { fit: 'cover', position: sharp.strategy.attention })
        .webp({ quality: 82 })
        .toBuffer();
    } catch (error) {
      this.logger.debug(`Avatar ilegible: ${(error as Error).message}`);
      throw this.noEsImagen();
    }
  }

  private noEsImagen(): AppException {
    return new AppException(
      ErrorCode.INVALID_IMAGE,
      'El archivo no es una imagen valida (JPEG, PNG, WebP, AVIF, GIF o HEIF)',
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    );
  }
}

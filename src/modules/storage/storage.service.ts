import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';

/** Un archivo ya guardado. `key` es lo que se persiste; `url` lo que se sirve. */
export interface StoredFile {
  key: string;
  url: string;
  bytes: number;
}

/**
 * Puerta unica de escritura de archivos binarios.
 *
 * La API entera guarda la **clave** (`avatars/xxx.webp`), nunca la URL final.
 * Asi mudar de dominio, de puerto o de driver (local → S3) no invalida ni una
 * fila: la URL se recalcula al leer. Lo contrario — guardar
 * `http://localhost:3000/uploads/...` en la BD — es una bomba de relojeria que
 * estalla el dia del despliegue.
 *
 * Es clase abstracta y no `interface` a proposito: Nest inyecta por token en
 * tiempo de ejecucion, y una interfaz de TypeScript no existe ahi.
 */
@Injectable()
export abstract class StorageService {
  abstract save(key: string, data: Buffer): Promise<StoredFile>;
  abstract delete(key: string): Promise<void>;
  abstract url(key: string): string;

  /**
   * Las imagenes se guardan como CLAVE de storage, pero algunas —la portada de
   * una maraton, por ejemplo— pueden venir del sitio del organizador: si ya es
   * absoluta se respeta tal cual. El cliente siempre recibe algo cargable.
   */
  publicUrl(valor: string | null | undefined): string | null {
    if (!valor) return null;

    return /^https?:\/\//i.test(valor) ? valor : this.url(valor);
  }
}

/** Prefijo publico bajo el que `main.ts` sirve el directorio de subidas. */
export const UPLOADS_PUBLIC_PREFIX = '/uploads';

/**
 * Driver local: escribe en `UPLOADS_DIR` y lo sirve como estatico.
 *
 * Suficiente para un VPS con un solo contenedor de API. El dia que haya dos
 * replicas o se quiera un CDN, se escribe `S3StorageService` con estos tres
 * metodos y no se toca ni una linea del resto del codigo.
 */
@Injectable()
export class LocalStorageService extends StorageService {
  private readonly logger = new Logger(LocalStorageService.name);
  private readonly root: string;
  private readonly baseUrl: string;

  constructor(config: AppConfigService) {
    super();
    this.root = resolve(config.get('UPLOADS_DIR'));
    this.baseUrl = config.get('PUBLIC_BASE_URL').replace(/\/+$/, '');
  }

  async save(key: string, data: Buffer): Promise<StoredFile> {
    const destino = this.resolveKey(key);
    await mkdir(dirname(destino), { recursive: true });
    await writeFile(destino, data);

    return { key, url: this.url(key), bytes: data.byteLength };
  }

  /**
   * Borrar es best-effort: que el archivo viejo no este ya no es un error para
   * quien acaba de subir uno nuevo. Se registra y se sigue.
   */
  async delete(key: string): Promise<void> {
    try {
      await rm(this.resolveKey(key), { force: true });
    } catch (error) {
      this.logger.warn(`No se pudo borrar ${key}: ${(error as Error).message}`);
    }
  }

  url(key: string): string {
    return `${this.baseUrl}${UPLOADS_PUBLIC_PREFIX}/${key.split(sep).join('/')}`;
  }

  /**
   * Traduce clave → ruta absoluta, rechazando cualquier cosa que se escape del
   * directorio raiz. Las claves las genera el servidor, pero una sola que salga
   * de datos del usuario y sin esto se convierte en escritura arbitraria.
   */
  private resolveKey(key: string): string {
    const limpio = normalize(key).replace(/^[\\/]+/, '');
    const destino = resolve(join(this.root, limpio));

    if (destino !== this.root && !destino.startsWith(this.root + sep)) {
      throw new Error(`Clave de archivo fuera del directorio de subidas: ${key}`);
    }

    return destino;
  }
}

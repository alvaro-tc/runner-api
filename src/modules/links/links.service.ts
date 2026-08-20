import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../database/prisma.service';
import { StorageService } from '../storage/storage.service';
import type { DatosDeEnlace } from './link-page';

/** Todo el enlace menos el nonce, que es de la respuesta y no del recurso. */
export type EnlaceResuelto = Omit<DatosDeEnlace, 'nonce'>;

/** Los tres tipos de recurso que se pueden compartir. */
export type TipoDeEnlace = 'marathon' | 'workout' | 'race';

@Injectable()
export class LinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Metadatos de un enlace, o `null` si el recurso no existe.
   *
   * **Que se publica y que no.** Una maraton publicada es informacion de
   * difusion: sale entera. Un entrenamiento y un resultado son de una persona,
   * y su id es la unica llave — quien tiene el enlace es porque su dueno se lo
   * dio. Por eso de esos dos sale lo minimo (que fue y cuanto duro) y **nunca
   * el nombre del corredor, su recorrido ni sus coordenadas**: la
   * previsualizacion de WhatsApp la ve todo el grupo, no solo a quien iba
   * dirigida. Ver `docs/decisiones.md`.
   */
  async resolver(tipo: TipoDeEnlace, id: string): Promise<EnlaceResuelto | null> {
    const base = {
      deepLink: `${this.config.get('APP_LINK_SCHEME')}://${tipo}/${encodeURIComponent(id)}`,
      canonical: this.canonical(tipo, id),
      appStoreUrl: this.config.get('APP_STORE_URL'),
      playStoreUrl: this.config.get('PLAY_STORE_URL'),
    };

    const contenido = await this.contenido(tipo, id);

    return contenido && { ...base, ...contenido };
  }

  /** URL publica de esta misma pagina. La necesita `og:url` y el canonical. */
  canonical(tipo: TipoDeEnlace, id: string): string {
    const raiz = this.config.get('PUBLIC_BASE_URL').replace(/\/+$/, '');

    return `${raiz}/api/v1/links/${tipo}/${encodeURIComponent(id)}`;
  }

  private contenido(
    tipo: TipoDeEnlace,
    id: string,
  ): Promise<Pick<DatosDeEnlace, 'title' | 'description' | 'imageUrl'> | null> {
    switch (tipo) {
      case 'marathon':
        return this.maraton(id);
      case 'workout':
        return this.entrenamiento(id);
      case 'race':
        return this.carrera(id);
    }
  }

  private async maraton(slug: string) {
    const maraton = await this.prisma.marathon.findFirst({
      // La misma condicion de visibilidad que el catalogo: lo no publicado no
      // existe aqui tampoco. Si no, un enlace filtrado adelantaria una carrera
      // que el organizador todavia no quiso anunciar.
      where: { slug, publishedAt: { not: null, lte: new Date() } },
      select: {
        name: true,
        city: true,
        startsAt: true,
        timezone: true,
        distanceMeters: true,
        coverUrl: true,
      },
    });

    if (!maraton) return null;

    return {
      title: maraton.name,
      description:
        `${(maraton.distanceMeters / 1000).toFixed(maraton.distanceMeters % 1000 === 0 ? 0 : 1)} K ` +
        `en ${maraton.city} · ${fecha(maraton.startsAt, maraton.timezone)}. ` +
        'Inscribite desde la app.',
      imageUrl: this.absoluta(maraton.coverUrl),
    };
  }

  private async entrenamiento(id: string) {
    const workout = await this.prisma.workout.findFirst({
      where: { id, deletedAt: null },
      select: { distanceMeters: true, durationSeconds: true },
    });

    if (!workout) return null;

    return {
      title: 'Un entrenamiento en PaceUp',
      description:
        `${(workout.distanceMeters / 1000).toFixed(2)} km en ${duracion(workout.durationSeconds)}. ` +
        'Abri la app para ver el detalle.',
      imageUrl: null,
    };
  }

  private async carrera(registrationId: string) {
    const resultado = await this.prisma.raceResult.findUnique({
      where: { registrationId },
      select: {
        finishTimeSeconds: true,
        shareCardUrl: true,
        registration: { select: { marathon: { select: { name: true } } } },
      },
    });

    if (!resultado) return null;

    return {
      title: resultado.registration.marathon.name,
      description: `Terminada en ${duracion(resultado.finishTimeSeconds)}. Mira el detalle en PaceUp.`,
      // Solo si el corredor genero la tarjeta. Generarla es un acto deliberado
      // suyo (`POST /races/:id/share-card`); mientras no exista, no hay imagen
      // que ensenar.
      imageUrl: this.absoluta(resultado.shareCardUrl),
    };
  }

  /**
   * Las imagenes se guardan como CLAVE de storage, no como URL (ver
   * `StorageService`). La portada de una maraton, en cambio, puede venir del
   * sitio del organizador: si ya es absoluta se respeta tal cual.
   */
  private absoluta(valor: string | null): string | null {
    if (!valor) return null;

    return /^https?:\/\//i.test(valor) ? valor : this.storage.url(valor);
  }
}

function fecha(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('es-BO', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone,
  }).format(at);
}

/** `h:mm:ss` o `mm:ss`. Nunca decimales: es un tiempo, no una medida. */
function duracion(segundos: number): string {
  const h = Math.floor(segundos / 3600);
  const m = Math.floor((segundos % 3600) / 60);
  const s = Math.floor(segundos % 60);
  const dosDigitos = (n: number) => String(n).padStart(2, '0');

  return h > 0 ? `${h}:${dosDigitos(m)}:${dosDigitos(s)}` : `${m}:${dosDigitos(s)}`;
}

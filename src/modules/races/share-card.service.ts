import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import { StorageService } from '../storage/storage.service';

/** Datos que se pintan en la tarjeta. Todo ya resuelto: aqui no se consulta nada. */
export interface DatosDeTarjeta {
  raceResultId: string;
  marathonName: string;
  city: string;
  finishedAt: Date;
  timezone: string;
  runnerName: string;
  bibNumber: string | null;
  finishTimeSeconds: number;
  distanceMeters: number;
  avgPaceSecPerKm: number | null;
  overallRank: number | null;
}

/** Formato vertical de historia de Instagram, que es donde acaba esto. */
const ANCHO = 1080;
const ALTO = 1350;

/**
 * Escapa lo que va dentro de un `<text>`.
 *
 * El nombre del corredor y el de la maraton vienen de la base, y un `&` o un
 * `<` en cualquiera de los dos rompe el SVG entero — el archivo deja de
 * parsear y sharp devuelve un error donde deberia haber una imagen.
 */
function xml(valor: string): string {
  return valor.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
}

/** `hh:mm:ss`, o `mm:ss` si no llega a la hora. */
export function formatearTiempo(segundos: number): string {
  const h = Math.floor(segundos / 3600);
  const m = Math.floor((segundos % 3600) / 60);
  const s = Math.floor(segundos % 60);
  const dosDigitos = (n: number) => String(n).padStart(2, '0');

  return h > 0 ? `${h}:${dosDigitos(m)}:${dosDigitos(s)}` : `${m}:${dosDigitos(s)}`;
}

/** Ritmo como lo lee un corredor: `5:12 /km`. */
export function formatearRitmo(segPorKm: number | null): string {
  if (segPorKm === null || segPorKm <= 0) return '—';
  return `${Math.floor(segPorKm / 60)}:${String(Math.round(segPorKm % 60)).padStart(2, '0')} /km`;
}

/** Distancia en km con una decimal y coma, como se escribe en Bolivia. */
export function formatearDistancia(metros: number): string {
  return `${(metros / 1000).toFixed(2).replace('.', ',')} km`;
}

/**
 * Tarjeta PNG del resultado, para compartir.
 *
 * Se compone como **SVG y se rasteriza con sharp**, que es lo que ya esta
 * instalado para los avatares. La alternativa —Puppeteer, un Chrome entero por
 * imagen— esta descartada en el PROMT y con razon: son ~400 MB de RAM por
 * proceso para dibujar seis lineas de texto.
 *
 * ponytail: el texto lo rasteriza librsvg con las fuentes **del sistema**. En un
 * VPS pelado no hay ninguna y la tarjeta sale en blanco: `fontconfig` y
 * `fonts-dejavu-core` estan en la lista de paquetes de `docs/despliegue.md`.
 * Empaquetar una fuente propia y registrarla es el siguiente paso si se quiere
 * una tipografia de marca.
 */
@Injectable()
export class ShareCardService {
  private readonly logger = new Logger(ShareCardService.name);

  constructor(private readonly storage: StorageService) {}

  async generar(datos: DatosDeTarjeta): Promise<string> {
    const png = await sharp(Buffer.from(this.componer(datos)))
      .png({ quality: 90 })
      .toBuffer();
    const guardado = await this.storage.save(`races/cards/${datos.raceResultId}.png`, png);

    this.logger.log(`Tarjeta de ${datos.raceResultId} generada (${guardado.bytes} bytes)`);

    return guardado.key;
  }

  private componer(datos: DatosDeTarjeta): string {
    const fecha = new Intl.DateTimeFormat('es-BO', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: datos.timezone,
    }).format(datos.finishedAt);

    const dorsal = datos.bibNumber ? `Dorsal ${xml(datos.bibNumber)}` : '';
    const puesto = datos.overallRank === null ? '' : `Puesto general #${datos.overallRank}`;

    // Coordenadas absolutas y no un layout: son seis lineas fijas, y montar un
    // motor de composicion para esto seria mas codigo que la tarjeta.
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${ANCHO}" height="${ALTO}">
  <defs>
    <linearGradient id="fondo" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0b1f3a"/>
      <stop offset="100%" stop-color="#123f6d"/>
    </linearGradient>
  </defs>
  <rect width="${ANCHO}" height="${ALTO}" fill="url(#fondo)"/>
  <g font-family="DejaVu Sans, Helvetica, Arial, sans-serif" fill="#ffffff" text-anchor="middle">
    <text x="540" y="180" font-size="34" fill="#7fd1ff" letter-spacing="6">FINISHER</text>
    <text x="540" y="270" font-size="58" font-weight="bold">${xml(datos.marathonName)}</text>
    <text x="540" y="330" font-size="32" fill="#b9d4ec">${xml(datos.city)} · ${xml(fecha)}</text>

    <text x="540" y="560" font-size="26" fill="#b9d4ec" letter-spacing="4">TIEMPO OFICIAL</text>
    <text x="540" y="700" font-size="150" font-weight="bold">${formatearTiempo(
      datos.finishTimeSeconds,
    )}</text>

    <text x="300" y="880" font-size="26" fill="#b9d4ec">DISTANCIA</text>
    <text x="300" y="940" font-size="48" font-weight="bold">${formatearDistancia(
      datos.distanceMeters,
    )}</text>

    <text x="780" y="880" font-size="26" fill="#b9d4ec">RITMO MEDIO</text>
    <text x="780" y="940" font-size="48" font-weight="bold">${formatearRitmo(
      datos.avgPaceSecPerKm,
    )}</text>

    <text x="540" y="1120" font-size="44" font-weight="bold">${xml(datos.runnerName)}</text>
    <text x="540" y="1180" font-size="30" fill="#b9d4ec">${dorsal}</text>
    <text x="540" y="1240" font-size="30" fill="#7fd1ff">${puesto}</text>
  </g>
</svg>`;
  }
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

// ─── Entrada ───────────────────────────────────────────────────────────────

/**
 * Las dos pestanas de la pantalla "Mis carreras".
 *
 * El corte lo pone la hora de largada de la maraton, no el resultado: una
 * carrera que ya paso pero cuyo resultado todavia no se cargo sigue siendo
 * pasada, y esconderla hasta que el organizador suba los tiempos dejaria al
 * usuario mirando una lista vacia el lunes por la manana.
 */
export enum RaceStatusFilter {
  upcoming = 'upcoming',
  completed = 'completed',
}

export class ListMyRacesQueryDto {
  @ApiPropertyOptional({ enum: RaceStatusFilter, description: 'Sin filtro devuelve las dos' })
  @IsOptional()
  @IsEnum(RaceStatusFilter)
  status?: RaceStatusFilter;
}

// ─── Salida ────────────────────────────────────────────────────────────────

export class RaceMarathonDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty({ example: 'Maratón de La Paz' })
  name!: string;

  @ApiProperty({ example: 'La Paz' })
  city!: string;

  @ApiProperty({ description: 'ISO-8601 UTC. La cuenta regresiva la calcula el cliente.' })
  startsAt!: string;

  @ApiProperty({ example: 'America/La_Paz', description: 'Zona IANA, para mostrar la hora local' })
  timezone!: string;

  @ApiProperty({ example: 42195 })
  distanceMeters!: number;

  @ApiProperty({ nullable: true })
  coverUrl!: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Retiro de kit: `{ from, to, address, lat, lng }`. Solo en las próximas.',
  })
  kitPickup!: unknown;
}

export class RaceResultDto {
  @ApiProperty({ example: 13_140, description: 'Tiempo oficial desde la largada, en segundos' })
  finishTimeSeconds!: number;

  @ApiProperty({
    nullable: true,
    example: 13_020,
    description: 'Tiempo propio del corredor, de su salida a su llegada',
  })
  chipTimeSeconds!: number | null;

  @ApiProperty({ example: 42195 })
  distanceMeters!: number;

  @ApiProperty({ nullable: true, example: 311, description: 'Segundos por km' })
  avgPaceSecPerKm!: number | null;

  @ApiProperty({ nullable: true, example: 3.21, description: 'Metros por segundo' })
  avgSpeedMps!: number | null;

  @ApiProperty({ example: 420 })
  elevationGainMeters!: number;

  @ApiProperty({ nullable: true, example: 12, description: 'Índice base 0 del km más rápido' })
  bestKmIndex!: number | null;

  @ApiProperty({ nullable: true, example: 42 })
  overallRank!: number | null;

  @ApiProperty({ nullable: true, example: 7 })
  categoryRank!: number | null;

  @ApiProperty({ nullable: true, description: 'Cuántos terminaron, para leer el puesto' })
  finishers!: number | null;

  @ApiProperty()
  finishedAt!: string;

  @ApiProperty({ nullable: true, description: 'PNG para compartir, si ya se generó' })
  shareCardUrl!: string | null;

  @ApiProperty({ nullable: true, description: 'Entrenamiento del que salieron las métricas' })
  workoutId!: string | null;
}

export class RaceSummaryDto {
  @ApiProperty({ description: 'Id de la inscripción: es la clave de toda esta sección' })
  registrationId!: string;

  @ApiProperty({ type: RaceMarathonDto })
  marathon!: RaceMarathonDto;

  @ApiProperty({ nullable: true, example: 'MLP-0042' })
  bibNumber!: string | null;

  @ApiProperty({ nullable: true, example: 'Elite Masculino' })
  categoryName!: string | null;

  @ApiProperty({ enum: RaceStatusFilter })
  status!: RaceStatusFilter;

  @ApiProperty({
    enum: ['paid', 'pending', 'refunded', 'failed'],
    nullable: true,
    description: 'Estado del cobro, tal como lo pinta la pantalla de carreras',
  })
  paymentStatus!: string | null;

  @ApiProperty({ nullable: true, description: 'Fecha de inscripción' })
  registeredAt!: string | null;

  @ApiProperty({ type: RaceResultDto, nullable: true, description: 'null si aún no hay resultado' })
  result!: RaceResultDto | null;
}

export class RaceCheckpointDto {
  @ApiProperty({ example: 5, description: 'Kilómetro de la marca: 5, 10, 15...' })
  kmMark!: number;

  @ApiProperty({ nullable: true })
  lat!: number | null;

  @ApiProperty({ nullable: true })
  lng!: number | null;

  @ApiProperty()
  passedAt!: string;

  @ApiProperty({ example: 1560, description: 'Segundos desde la largada hasta esta marca' })
  splitSeconds!: number;
}

export class RaceSplitDto {
  @ApiProperty({ example: 0, description: 'Base 0: el split 0 es el primer kilómetro' })
  index!: number;

  @ApiProperty({ example: 1000 })
  distanceMeters!: number;

  @ApiProperty({ example: 312 })
  durationSeconds!: number;

  @ApiProperty({ example: 312 })
  paceSecPerKm!: number;

  @ApiProperty({ example: 12 })
  elevationGainMeters!: number;
}

export class RaceSplitsDto {
  @ApiProperty({ type: [RaceSplitDto] })
  splits!: RaceSplitDto[];

  @ApiProperty({ type: [RaceCheckpointDto], description: 'Marcadores cada 5 km' })
  checkpoints!: RaceCheckpointDto[];
}

export class RaceDetailDto extends RaceSummaryDto {
  @ApiProperty({ type: [RaceSplitDto], description: 'Parciales por km. Vacío sin resultado.' })
  splits!: RaceSplitDto[];

  @ApiProperty({ type: [RaceCheckpointDto] })
  checkpoints!: RaceCheckpointDto[];

  @ApiProperty({
    nullable: true,
    example: { type: 'LineString', coordinates: [[-68.13, -16.49]] },
    description:
      'Recorrido simplificado con Douglas-Peucker, en orden GeoJSON `[lng, lat]`. Tope de ' +
      '2.000 vértices: la forma es la misma y el JSON entra en unos pocos KB.',
  })
  routeGeoJson!: unknown;
}

export class MyRacesSummaryDto {
  @ApiProperty({ example: 3, description: 'Maratones terminadas con resultado cargado' })
  racesCompleted!: number;

  @ApiProperty({ example: 2, description: 'Inscripciones confirmadas que todavía no se corrieron' })
  racesUpcoming!: number;

  @ApiProperty({ example: 126_585, description: 'Suma de las distancias de las carreras corridas' })
  totalDistanceMeters!: number;

  @ApiProperty({
    example: 74_000,
    description:
      'Suma de los pagos en estado `paid`. Un pago reembolsado deja de estar `paid`, así que ' +
      'no hay que restarlo aparte.',
  })
  totalSpentCents!: number;

  @ApiProperty({ example: 'BOB' })
  currency!: string;

  @ApiProperty({
    type: RaceSummaryDto,
    nullable: true,
    description: 'La próxima carrera, para la cuenta regresiva de la cabecera',
  })
  nextRace!: RaceSummaryDto | null;
}

export class ShareCardDto {
  @ApiProperty({ example: 'http://localhost:3000/uploads/races/cards/res_abc.png' })
  url!: string;
}

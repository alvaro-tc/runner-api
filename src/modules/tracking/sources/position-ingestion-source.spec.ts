import { OsmAndSource } from './position-ingestion-source';
import type { OsmAndQueryDto } from '../dto/tracking.dto';

/**
 * La clave con la que se deduplica un punto de OsmAnd.
 *
 * Es lo unico no trivial de esta traduccion y rompe en silencio: el indice
 * unico de `positions` es global —`(clientPointId, recordedAt)`—, asi que una
 * clave que solo mire el reloj hace chocar a dos corredores distintos que
 * mandan en el mismo segundo, y `skipDuplicates` se traga al segundo sin que
 * nadie vea un error.
 */
describe('OsmAndSource — clave de deduplicacion', () => {
  const fuente = new OsmAndSource();

  const punto = (id: string, timestamp: string): OsmAndQueryDto =>
    ({ id, lat: '-16.4957', lon: '-68.1335', timestamp });

  /** OsmAnd manda un punto por peticion: la traduccion devuelve siempre uno. */
  const unico = (q: OsmAndQueryDto) => fuente.aPuntos(q)[0]!;

  it('dos corredores en el mismo segundo no colisionan', () => {
    const uno = unico(punto('device-a', '1787000000'));
    const otro = unico(punto('device-b', '1787000000'));

    expect(uno.clientPointId).not.toEqual(otro.clientPointId);
    expect(uno.recordedAt).toEqual(otro.recordedAt);
  });

  it('el mismo tracker reintentando el mismo punto si deduplica', () => {
    const uno = unico(punto('device-a', '1787000000'));
    const otro = unico(punto('device-a', '1787000000'));

    expect(uno.clientPointId).toEqual(otro.clientPointId);
  });
});

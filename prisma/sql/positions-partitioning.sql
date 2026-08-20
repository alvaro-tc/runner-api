-- Particionado mensual de `positions`.
--
-- Este bloque se inserta a mano en la migracion inicial porque Prisma no sabe
-- expresar particionado. Se mantiene aqui aparte para poder releerlo sin
-- bucear en un archivo de 800 lineas; la copia que MANDA es la que vive dentro
-- de `prisma/migrations/*_init/migration.sql`.
--
-- Por que particionar: `positions` es la unica tabla que crece sin techo. Un
-- corredor genera ~1 punto/segundo, asi que una maraton de 4 horas son ~14.400
-- filas por persona. Particionar por mes permite archivar o borrar un mes
-- entero con un DROP TABLE instantaneo, en vez de un DELETE que bloquea.

-- ─────────────────────────────────────────────────────────────────────────────
-- Crea (si no existe) la particion mensual que contiene la fecha dada.
--
-- La llama el job mensual y tambien el arranque, para no depender de que el job
-- haya corrido. Es idempotente: llamarla dos veces no falla.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_positions_partition(target_date DATE)
RETURNS TEXT AS $$
DECLARE
  range_start DATE := date_trunc('month', target_date)::DATE;
  range_end   DATE := (date_trunc('month', target_date) + INTERVAL '1 month')::DATE;
  part_name   TEXT := 'positions_' || to_char(range_start, 'YYYY_MM');
BEGIN
  IF to_regclass(format('public.%I', part_name)) IS NOT NULL THEN
    RETURN part_name || ' (ya existia)';
  END IF;

  EXECUTE format(
    'CREATE TABLE %I PARTITION OF positions FOR VALUES FROM (%L) TO (%L)',
    part_name, range_start, range_end
  );

  RETURN part_name || ' (creada)';
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────────
-- Particiones iniciales: 6 meses hacia atras (para los seeds historicos) y 18
-- hacia adelante. El job mensual va creando las siguientes.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  m DATE := (date_trunc('month', CURRENT_DATE) - INTERVAL '6 months')::DATE;
BEGIN
  WHILE m < (date_trunc('month', CURRENT_DATE) + INTERVAL '18 months')::DATE LOOP
    PERFORM create_positions_partition(m);
    m := (m + INTERVAL '1 month')::DATE;
  END LOOP;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Particion de respaldo.
--
-- Sin ella, un punto con fecha fuera de todo rango hace fallar el INSERT y se
-- pierde un dato de GPS que el usuario no puede volver a generar. Prefiero un
-- punto en la particion equivocada a un punto perdido.
--
-- OJO al operar: si `positions_default` llega a contener filas de un mes, crear
-- despues la particion de ese mes falla (Postgres tiene que validar que no se
-- solapan). Se arregla moviendo esas filas antes de crear la particion.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS positions_default PARTITION OF positions DEFAULT;

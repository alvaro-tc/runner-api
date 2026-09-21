-- Maratones en circuito: N vueltas al mismo trazado.
--
-- `distanceMeters` sigue siendo el total que corre el inscrito, asi que las
-- filas existentes quedan correctas con `laps = 1` y nada que recalcular.
ALTER TABLE "marathons" ADD COLUMN "laps" INTEGER NOT NULL DEFAULT 1;

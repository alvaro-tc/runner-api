-- Dos logos por maraton, vertical y horizontal. Columnas nuevas y nulas: las
-- filas existentes no se tocan y la app cae a `coverUrl` mientras falten.
ALTER TABLE "marathons" ADD COLUMN "logoVerticalUrl" TEXT;
ALTER TABLE "marathons" ADD COLUMN "logoHorizontalUrl" TEXT;

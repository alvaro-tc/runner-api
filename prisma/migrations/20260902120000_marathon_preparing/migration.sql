-- Estado "en preparacion" de una maraton y deteccion de llegada por GPS.
--
-- El estado en vivo se sigue derivando de fechas y no de un enum: `preparingAt`
-- se suma a `liveStartedAt`/`liveFinishedAt` y las tres juntas dan los cuatro
-- estados (no iniciada, en preparacion, en progreso, terminada). Un enum
-- paralelo a las fechas seria un segundo sitio donde equivocarse.
ALTER TABLE "marathons" ADD COLUMN "preparingAt" TIMESTAMP(3);
ALTER TABLE "marathons" ADD COLUMN "preparingMessage" TEXT;

CREATE INDEX "marathons_preparingAt_idx" ON "marathons"("preparingAt");

ALTER TABLE "tracking_sessions" ADD COLUMN "finishDetectedAt" TIMESTAMP(3);

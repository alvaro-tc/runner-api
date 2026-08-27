-- Largada y corte en vivo de una maraton. Los da el admin desde el panel: no se
-- derivan de `startsAt`, que es la hora programada y casi nunca la real.
ALTER TABLE "marathons" ADD COLUMN "liveStartedAt" TIMESTAMP(3);
ALTER TABLE "marathons" ADD COLUMN "liveFinishedAt" TIMESTAMP(3);

-- El movil de cada corredor pregunta "hay alguna maraton mia corriendo ahora".
CREATE INDEX "marathons_liveStartedAt_idx" ON "marathons"("liveStartedAt");

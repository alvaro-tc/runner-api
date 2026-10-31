-- Vistas del detalle de cada maraton y visitas a la pagina de inicio.
ALTER TABLE "marathons" ADD COLUMN "views" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "site_counters" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "site_counters_pkey" PRIMARY KEY ("key")
);

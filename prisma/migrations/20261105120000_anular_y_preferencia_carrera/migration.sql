-- Pago en efectivo registrado por un organizador (inscripcion en fisico).
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'cash';

-- Inscribir en fisico: admin y organizador.
UPDATE "roles" SET "permissions" = array_append("permissions", 'inscritas.manual'), "updatedAt" = NOW()
WHERE "key" IN ('admin', 'organizer') AND NOT ('inscritas.manual' = ANY("permissions"));

-- Anular una inscripcion (devolver el pago) pasa a ser permiso propio, solo del admin.
UPDATE "roles" SET "permissions" = array_append("permissions", 'inscritas.anular'), "updatedAt" = NOW()
WHERE "key" = 'admin' AND NOT ('inscritas.anular' = ANY("permissions"));

-- Carrera elegida en el panel web, por usuario.
ALTER TABLE "user_preferences" ADD COLUMN "marathonId" TEXT;

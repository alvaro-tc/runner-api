-- API de cobros QR (pasarela) y validador de pagos por maraton.
--
-- El administrador de plataforma decide si la API externa esta encendida y a
-- quien se le asigna la validacion de cada maraton: a la cuenta `api` (la
-- pasarela genera el QR y confirma sola) o a un organizador (QR por defecto
-- de la maraton y validacion a mano).

ALTER TYPE "PaymentProviderName" ADD VALUE IF NOT EXISTS 'pasarela';

CREATE TABLE "platform_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "paymentApiEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "platform_config_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_config_una_fila" CHECK ("id" = 1)
);
INSERT INTO "platform_config" ("id") VALUES (1);

INSERT INTO "roles" ("key", "name", "description", "permissions", "system", "updatedAt") VALUES
  ('plataforma', 'Administrador de plataforma', 'Enciende o apaga la API de pagos y asigna quién valida los cobros de cada carrera.',
    ARRAY['plataforma.gestionar','carreras.ver','cobros.ver','auditoria.ver'], true, NOW()),
  ('api', 'API de pagos', 'Cuenta de sistema: la pasarela que genera los QR y valida los pagos sola. No inicia sesión.',
    ARRAY[]::TEXT[], true, NOW());

-- La cuenta que firma lo que valida la pasarela. Sin contraseña ni login
-- social: nadie puede entrar con ella.
INSERT INTO "users" ("id", "email", "name", "role", "updatedAt")
VALUES ('api-pasarela', 'api@pasarela.local', 'API de pagos', 'api', NOW());

ALTER TABLE "marathons" ADD COLUMN "paymentValidatorId" TEXT;
ALTER TABLE "marathons" ADD CONSTRAINT "marathons_paymentValidatorId_fkey" FOREIGN KEY ("paymentValidatorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

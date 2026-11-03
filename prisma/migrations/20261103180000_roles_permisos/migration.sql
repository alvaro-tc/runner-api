-- Roles con permisos por modulo. `users.role` pasa de enum a texto con FK a
-- `roles.key`; las claves de siempre se conservan, asi que ni el token ni la
-- app cambian.
--
-- Ningun rol tiene permisos implicitos, tampoco `admin`: todo esta aqui y se
-- puede revocar. Separacion de funciones por defecto: el admin opera las
-- carreras y el OSI gestiona accesos; el auditor solo mira.
CREATE TABLE "roles" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "system" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "roles_pkey" PRIMARY KEY ("key")
);

INSERT INTO "roles" ("key", "name", "description", "permissions", "system", "updatedAt") VALUES
  ('runner', 'Corredora', 'Cuenta normal de la app y la web. Sin acceso al panel.', ARRAY[]::TEXT[], true, NOW()),
  ('admin', 'Administrador', 'Opera las carreras, los cobros y la configuración. No gestiona accesos.',
    ARRAY['carreras.ver','carreras.editar','resumen.ver','inscritas.ver','inscritas.exportar','cobros.ver','cobros.validar','usuarios.ver','usuarios.gestionar','config.gestionar'], true, NOW()),
  ('organizer', 'Organizador', 'Valida cobros y atiende a las corredoras del día a día.',
    ARRAY['carreras.ver','resumen.ver','inscritas.ver','inscritas.exportar','cobros.ver','cobros.validar','usuarios.ver','usuarios.gestionar'], true, NOW()),
  ('osi', 'OSI', 'Oficial de Seguridad de la Información: cuentas, roles y permisos.',
    ARRAY['usuarios.ver','usuarios.gestionar','roles.asignar','roles.gestionar','auditoria.ver'], true, NOW()),
  ('auditor', 'Auditor', 'Revisa el registro de cambios y consulta todo sin modificar nada.',
    ARRAY['auditoria.ver','carreras.ver','resumen.ver','inscritas.ver','cobros.ver','usuarios.ver'], false, NOW()),
  ('veedor', 'Veedor', 'Solo mira las carreras y sus inscritas. No modifica nada.',
    ARRAY['carreras.ver','inscritas.ver'], false, NOW());

ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "role" TYPE TEXT USING "role"::TEXT;
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'runner';
DROP TYPE "UserRole";

ALTER TABLE "users" ADD CONSTRAINT "users_role_fkey" FOREIGN KEY ("role") REFERENCES "roles"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorRole" TEXT,
    "method" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "targetId" TEXT,
    "status" INTEGER NOT NULL,
    "detail" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");
CREATE INDEX "audit_logs_actorId_createdAt_idx" ON "audit_logs"("actorId", "createdAt");
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

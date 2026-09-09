-- Cuentas creadas con Google: no tienen contrasena y no deben fingir que si.
-- Solo relaja una restriccion, asi que las filas existentes no se tocan y la
-- migracion no puede fallar por datos.
ALTER TABLE "users" ALTER COLUMN "passwordHash" DROP NOT NULL;

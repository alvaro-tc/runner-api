-- Sign in with Apple. La identidad de Apple es su `sub`, no el email: con
-- "Ocultar mi correo" el email es un relay que no coincide con nada. El refresh
-- token se guarda solo para revocarlo al borrar la cuenta, como exige Apple.
-- Columnas nuevas y nulas: las filas existentes no se tocan.
ALTER TABLE "users" ADD COLUMN "appleSub" TEXT;
ALTER TABLE "users" ADD COLUMN "appleRefreshToken" TEXT;
ALTER TABLE "users" ADD COLUMN "appleClientId" TEXT;

CREATE UNIQUE INDEX "users_appleSub_key" ON "users"("appleSub");

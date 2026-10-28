-- Ensayos: copias privadas de una maraton para probar la largada con
-- inscritos de prueba sin tocar la real ni a sus inscritos. Columna nueva y
-- nula: las maratones existentes no son ensayos.
ALTER TABLE "marathons" ADD COLUMN "rehearsalOfId" TEXT;

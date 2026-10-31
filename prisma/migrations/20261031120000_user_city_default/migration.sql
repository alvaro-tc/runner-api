-- Ciudad por defecto: La Paz. Aplica a perfiles nuevos y rellena los existentes sin ciudad.
ALTER TABLE "user_profiles" ALTER COLUMN "city" SET DEFAULT 'La Paz';
UPDATE "user_profiles" SET "city" = 'La Paz' WHERE "city" IS NULL;

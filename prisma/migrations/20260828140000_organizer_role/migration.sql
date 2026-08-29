-- Rol `organizer`: admin recortado (usuarios + comprobantes de pago).
-- Va antes de `admin` en el enum solo por orden de privilegio; el orden de un
-- enum de Postgres no afecta a nada mas que a ORDER BY.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'organizer' BEFORE 'admin';

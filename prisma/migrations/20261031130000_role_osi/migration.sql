-- Rol `osi` (Oficial de Seguridad de la Informacion): solo administra cuentas.
-- Va antes de `admin` en el enum por orden de privilegio, como `organizer`.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'osi' BEFORE 'admin';

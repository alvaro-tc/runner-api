-- Auditoria de los cobros aprobados a mano.
--
-- Hasta ahora quien confirmaba una transferencia quedaba como un id suelto
-- dentro de `methodDetails`, un JSON que no se puede unir con `users`: para
-- responder "quien dio esto por pagado" habia que resolver el cuid a mano. Con
-- la columna, la respuesta sale del mismo SELECT que pinta el pago.
--
-- `ON DELETE SET NULL`: si la cuenta del organizador se borra, el cobro sigue
-- siendo valido; lo que se pierde es el nombre, no el dinero.
ALTER TABLE "payments" ADD COLUMN "confirmedById" TEXT;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_confirmedById_fkey"
  FOREIGN KEY ("confirmedById") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Rellena lo ya aprobado con el id que quedo en el JSON, para no empezar la
-- auditoria con un agujero del tamano de todo el historico.
UPDATE "payments" p
SET "confirmedById" = u."id"
FROM "users" u
WHERE p."confirmedById" IS NULL
  AND u."id" = p."methodDetails" #>> '{bank,confirmedBy}';

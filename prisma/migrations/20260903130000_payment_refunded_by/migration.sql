-- Auditoria de las devoluciones ordenadas a mano desde el panel.
--
-- Columna propia y no reutilizar `confirmedById`: aprobar un cobro y devolverlo
-- son dos decisiones distintas, a veces de dos personas distintas. Pisar la
-- primera con la segunda deja la auditoria sin lo unico que se le pide.
--
-- El motivo sigue en `failureReason`, que es donde ya lo escriben el webhook y
-- la cancelacion: un segundo campo para lo mismo seria un segundo sitio donde
-- mirar.
ALTER TABLE "payments" ADD COLUMN "refundedById" TEXT;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_refundedById_fkey"
  FOREIGN KEY ("refundedById") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

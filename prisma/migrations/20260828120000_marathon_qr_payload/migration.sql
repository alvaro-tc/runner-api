-- TEMPORAL — cobro por QR manual. Ver docs/pago-qr-manual.md.
-- El QR pasa de imagen a texto: la app lo pinta. `paymentQrUrl` se queda como
-- respaldo de las maratones que ya tenian la imagen subida.
ALTER TABLE "marathons" ADD COLUMN "paymentQrPayload" TEXT;

-- Al desmontar el QR manual, esto se borra junto con lo demas:
-- ALTER TABLE "marathons" DROP COLUMN "paymentQrPayload";

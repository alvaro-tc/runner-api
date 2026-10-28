-- Logo que la app pinta en el centro del QR de cobro. Nula: sin logo el QR se
-- dibuja liso, como hasta ahora.
ALTER TABLE "marathons" ADD COLUMN "logoQrUrl" TEXT;

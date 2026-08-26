-- Cobro por QR verificado a mano (TEMPORAL). Ver docs/pago-qr-manual.md.
-- Todo lo que añade esta migración se revierte con el bloque comentado al final.

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'qr_manual';

-- AlterEnum
ALTER TYPE "PaymentProviderName" ADD VALUE 'manual';

-- CreateEnum
CREATE TYPE "PaymentProofStatus" AS ENUM ('in_review', 'approved', 'rejected');

-- AlterTable: el email pasa a ser opcional (se puede entrar solo con CI)
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN "ci" TEXT;
ALTER TABLE "users" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "users_ci_key" ON "users"("ci");

-- AlterTable
ALTER TABLE "marathons" ADD COLUMN "paymentQrUrl" TEXT;
ALTER TABLE "marathons" ADD COLUMN "paymentQrInstructions" TEXT;

-- AlterTable
ALTER TABLE "registrations" ADD COLUMN "publicToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "registrations_publicToken_key" ON "registrations"("publicToken");

-- CreateTable
CREATE TABLE "payment_proofs" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "imageKey" TEXT NOT NULL,
    "status" "PaymentProofStatus" NOT NULL DEFAULT 'in_review',
    "reference" TEXT,
    "note" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_proofs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_proofs_paymentId_createdAt_idx" ON "payment_proofs"("paymentId", "createdAt");

-- CreateIndex
CREATE INDEX "payment_proofs_status_createdAt_idx" ON "payment_proofs"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Marcha atrás, el día que entre una pasarela real:
--
--   DROP TABLE "payment_proofs";
--   DROP TYPE "PaymentProofStatus";
--   ALTER TABLE "marathons" DROP COLUMN "paymentQrUrl", DROP COLUMN "paymentQrInstructions";
--   ALTER TABLE "registrations" DROP COLUMN "publicToken";
--
-- `ci`, `mustChangePassword` y el email opcional NO se revierten: son del
-- modelo de cuentas, no del cobro manual.
-- ─────────────────────────────────────────────────────────────────────────────

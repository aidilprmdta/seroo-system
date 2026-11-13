CREATE TYPE "PaymentStatus" AS ENUM ('RECORDED', 'PENDING_RECONCILIATION');

ALTER TABLE "Order"
ADD COLUMN "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'RECORDED',
ADD COLUMN "clientTransactionId" TEXT,
ADD COLUMN "payloadHash" TEXT;

CREATE UNIQUE INDEX "Order_outletId_crewId_clientTransactionId_key"
ON "Order"("outletId", "crewId", "clientTransactionId");

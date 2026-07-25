-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');

-- DropIndex
--
-- Same Prisma-diff gotcha documented in packages/db/ER_DIAGRAM.md and hit
-- again by 20260724095537_add_semantic_cache_model: the diff engine still
-- doesn't understand the raw-SQL ivfflat index on semantic_cache and drops
-- it on ANY schema change, even one that touches unrelated tables (this
-- migration is entirely about billing_plans/invoices/stripe_events/
-- outbox_events). Recreated immediately below.
DROP INDEX "semantic_cache_embedding_idx";

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "monthly_budget_override_usd" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "billing_plans" (
    "id" UUID NOT NULL,
    "plan_tier" "Plan" NOT NULL,
    "monthly_budget_usd" DECIMAL(12,2) NOT NULL,
    "price_usd" DECIMAL(12,2) NOT NULL,
    "stripe_price_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "stripe_invoice_id" TEXT,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "amount_usd" DECIMAL(12,2) NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" UUID NOT NULL,
    "stripe_event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_plans_plan_tier_key" ON "billing_plans"("plan_tier");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_stripe_invoice_id_key" ON "invoices"("stripe_invoice_id");

-- CreateIndex
CREATE INDEX "invoices_org_id_period_start_idx" ON "invoices"("org_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "stripe_events_stripe_event_id_key" ON "stripe_events"("stripe_event_id");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex (recreate the ivfflat cosine-similarity index dropped above —
-- see the comment on the DROP INDEX statement)
CREATE INDEX "semantic_cache_embedding_idx" ON "semantic_cache"
  USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

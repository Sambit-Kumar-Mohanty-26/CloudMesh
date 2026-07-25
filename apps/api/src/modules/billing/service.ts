import { getBudgetStatus, type BudgetStatus } from "@cloudmesh/billing";
import { Prisma, withTenant, type PrismaClient } from "@cloudmesh/db";
import type { StripeWebhookEvent } from "../../providers/stripe.js";

export interface BillingDeps {
  db: PrismaClient;
}

export async function getOrgBudgetStatus(
  { db }: BillingDeps,
  orgId: string,
): Promise<BudgetStatus> {
  return getBudgetStatus(db, orgId);
}

export async function updateBudgetOverride(
  { db }: BillingDeps,
  orgId: string,
  monthlyBudgetOverrideUsd: number | null,
): Promise<void> {
  // organizations has no RLS (see CLAUDE.md) — a plain update by id, same
  // as everywhere else this table is written.
  await db.organization.update({
    where: { id: orgId },
    data: { monthlyBudgetOverrideUsd },
  });
}

export interface InvoiceSummary {
  id: string;
  stripeInvoiceId: string | null;
  periodStart: Date;
  periodEnd: Date;
  amountUsd: number;
  status: string;
  createdAt: Date;
}

export async function listInvoices({ db }: BillingDeps, orgId: string): Promise<InvoiceSummary[]> {
  const rows = await withTenant(db, orgId, (tx) =>
    tx.invoice.findMany({
      where: { orgId },
      orderBy: { periodStart: "desc" },
    }),
  );
  return rows.map((row) => ({
    id: row.id,
    stripeInvoiceId: row.stripeInvoiceId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    amountUsd: Number(row.amountUsd),
    status: row.status,
    createdAt: row.createdAt,
  }));
}

interface StripeInvoiceObject {
  id: string;
  customer: string;
  period_start: number;
  period_end: number;
  amount_due?: number;
  amount_paid?: number;
}

const EVENT_STATUS: Record<string, "PENDING" | "PAID" | "FAILED"> = {
  "invoice.created": "PENDING",
  "invoice.paid": "PAID",
  "invoice.payment_failed": "FAILED",
};

export interface WebhookProcessResult {
  /** false for a webhook type this handler doesn't act on (still a valid,
   *  successfully-received event — just not one that changes anything
   *  here), or for one whose Stripe customer doesn't map to a known org. */
  processed: boolean;
  reason?: string;
}

/**
 * Idempotent: `stripe_events` is a dedup log keyed by Stripe's own event id
 * — a redelivered webhook (Stripe retries on timeout/non-2xx) is a no-op on
 * the second delivery, not a double-processed invoice. The insert-first,
 * process-second order matters: if this crashed between them, the event
 * would be marked "seen" but never actually applied — an accepted trade-off
 * (a genuinely lost update needs a reconciliation job regardless) versus
 * the alternative of processing first and dedup-marking after, which risks
 * double-processing on a crash instead, the worse failure mode for money.
 */
export async function processStripeWebhookEvent(
  { db }: BillingDeps,
  event: StripeWebhookEvent,
): Promise<WebhookProcessResult> {
  try {
    await db.stripeEvent.create({
      data: { stripeEventId: event.id, type: event.type },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { processed: false, reason: "duplicate event (already processed)" };
    }
    throw err;
  }

  const status = EVENT_STATUS[event.type];
  if (!status) {
    return { processed: false, reason: `unhandled event type: ${event.type}` };
  }

  const invoice = event.data.object as unknown as StripeInvoiceObject;
  const org = await db.organization.findFirst({
    where: { stripeCustomerId: invoice.customer },
    select: { id: true },
  });
  if (!org) {
    return {
      processed: false,
      reason: `no organization found for Stripe customer ${invoice.customer}`,
    };
  }

  const amountCents = invoice.amount_paid ?? invoice.amount_due ?? 0;
  await withTenant(db, org.id, (tx) =>
    tx.invoice.upsert({
      where: { stripeInvoiceId: invoice.id },
      create: {
        orgId: org.id,
        stripeInvoiceId: invoice.id,
        periodStart: new Date(invoice.period_start * 1000),
        periodEnd: new Date(invoice.period_end * 1000),
        amountUsd: amountCents / 100,
        status,
      },
      update: { status, amountUsd: amountCents / 100 },
    }),
  );

  return { processed: true };
}

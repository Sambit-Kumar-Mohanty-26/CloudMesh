import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { ForbiddenError, ValidationError } from "../../errors.js";
import { requireJwt } from "../../middleware/requireJwt.js";
import { getOrgBudgetStatus, listInvoices, updateBudgetOverride } from "./service.js";
import { updateBudgetSchema } from "./schemas.js";

// Changing an org's spending cap is a money-affecting mutation — the same
// category of risk as minting an API key (see apiKeys/routes.ts), just
// pointed at billing instead of credentials. A leaked JWT shouldn't be
// able to flap an org's budget (or hammer the DB doing it) faster than
// someone notices. Tighter than the generic global baseline in app.ts.
const updateBudgetRateLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

// Reads are lower-risk than the mutation above, but still get an explicit
// limit rather than relying on the implicit global default — every route
// in this router touches billing data, so none of them should be the one
// place a limit is silently inherited instead of stated.
const billingReadRateLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

export default async function billingRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", requireJwt);

  fastify.get("/billing/status", billingReadRateLimit, async (request) => {
    const orgId = request.user!.orgId;
    return getOrgBudgetStatus({ db: fastify.db }, orgId);
  });

  fastify.patch("/billing/budget", updateBudgetRateLimit, async (request, reply) => {
    // Only OWNER/ADMIN can change what an org spends money on — MEMBER is
    // read-only here, same tier split as everywhere else role matters.
    if (request.user!.role !== "OWNER" && request.user!.role !== "ADMIN") {
      throw new ForbiddenError("Only an owner or admin can change the billing budget");
    }

    let input;
    try {
      input = updateBudgetSchema.parse(request.body);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError(err.issues[0]?.message ?? "Invalid request");
      }
      throw err;
    }

    const orgId = request.user!.orgId;
    await updateBudgetOverride({ db: fastify.db }, orgId, input.monthlyBudgetOverrideUsd);
    reply.code(204);
  });

  fastify.get("/billing/invoices", billingReadRateLimit, async (request) => {
    const orgId = request.user!.orgId;
    return listInvoices({ db: fastify.db }, orgId);
  });
}

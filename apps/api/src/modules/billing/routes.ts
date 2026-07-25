import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { ForbiddenError, ValidationError } from "../../errors.js";
import { requireJwt } from "../../middleware/requireJwt.js";
import { getOrgBudgetStatus, listInvoices, updateBudgetOverride } from "./service.js";
import { updateBudgetSchema } from "./schemas.js";

export default async function billingRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", requireJwt);

  fastify.get("/billing/status", async (request) => {
    const orgId = request.user!.orgId;
    return getOrgBudgetStatus({ db: fastify.db }, orgId);
  });

  fastify.patch("/billing/budget", async (request, reply) => {
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

  fastify.get("/billing/invoices", async (request) => {
    const orgId = request.user!.orgId;
    return listInvoices({ db: fastify.db }, orgId);
  });
}

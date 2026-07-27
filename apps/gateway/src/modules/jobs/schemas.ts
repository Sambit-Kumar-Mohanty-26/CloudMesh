import { z } from "zod";

export const createJobSchema = z.object({
  type: z.string().min(1).max(100),
  // Validated per-type by the handler's own parsePayload (see handlers.ts) —
  // this only guarantees it's present and an object, since each job type
  // has its own payload shape.
  payload: z.unknown(),
  priority: z.enum(["CRITICAL", "HIGH", "NORMAL", "LOW"]).optional(),
});
export type CreateJobInput = z.infer<typeof createJobSchema>;

export const listJobsQuerySchema = z.object({
  status: z.enum(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "DEAD_LETTER"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

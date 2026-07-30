import { z } from "zod";

export const periodSchema = z.enum(["24h", "7d", "30d"]).default("7d");

export const logsQuerySchema = z.object({
  model: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

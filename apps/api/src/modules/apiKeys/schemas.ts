import { z } from "zod";

export const createApiKeySchema = z.object({
  scopes: z.array(z.string().min(1).max(64)).min(1).max(32),
  rateLimitRpm: z.coerce.number().int().min(1).max(100_000).optional(),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

import { z } from "zod";

export const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1).max(100_000),
});

export const chatRequestSchema = z.object({
  model: z.string().min(1).max(100),
  messages: z.array(messageSchema).min(1).max(200),
  stream: z.boolean().optional(),
  maxTokens: z.coerce.number().int().positive().max(100_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
});
export type ChatRequestInput = z.infer<typeof chatRequestSchema>;

import { z } from "zod";

export const registerSchema = z.object({
  orgName: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(1000), // strength is checked separately, with a dedicated message
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(1000),
});
export type LoginInput = z.infer<typeof loginSchema>;

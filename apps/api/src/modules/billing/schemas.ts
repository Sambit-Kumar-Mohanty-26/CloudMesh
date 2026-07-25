import { z } from "zod";

export const updateBudgetSchema = z.object({
  // null explicitly clears the override, falling back to the plan's
  // default budget — distinct from omitting the field (which zod would
  // treat as "leave unset," not "clear it").
  monthlyBudgetOverrideUsd: z.coerce.number().positive().nullable(),
});
export type UpdateBudgetInput = z.infer<typeof updateBudgetSchema>;

import { isWebhookEventType, WEBHOOK_EVENT_TYPES } from "@cloudmesh/webhooks";
import { z } from "zod";

// URL shape/reachability/safety is deliberately left to the single SSRF
// gate in @cloudmesh/webhooks (registerWebhookEndpoint calls
// isSafeWebhookTarget) rather than duplicated here with z.string().url() —
// one gate for "is this URL acceptable," not two that could disagree.
export const registerWebhookSchema = z.object({
  url: z.string().min(1).max(2048),
  eventTypes: z
    .array(z.string())
    .min(1)
    .max(WEBHOOK_EVENT_TYPES.length)
    .refine((types) => types.every(isWebhookEventType), {
      message: `eventTypes must only contain: ${WEBHOOK_EVENT_TYPES.join(", ")}`,
    }),
});
export type RegisterWebhookInput = z.infer<typeof registerWebhookSchema>;

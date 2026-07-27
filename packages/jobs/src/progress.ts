import type { Redis } from "ioredis";

/** Design doc: `Worker → Redis PUBLISH job:{id}:progress {pct}`. Keyed by
 *  the `jobs.id` UUID, not the BullMQ job id, so the WebSocket route can
 *  subscribe using the same id the client was handed at submission. */
export function jobProgressChannel(jobRecordId: string): string {
  return `job:${jobRecordId}:progress`;
}

export interface JobProgressEvent {
  jobId: string;
  progress: number;
  status: "RUNNING" | "COMPLETED" | "FAILED" | "DEAD_LETTER";
  /** Present only on terminal failure states — a short message, never a raw
   *  error object (provider errors can echo prompt/response text). */
  error?: string;
}

export async function publishJobProgress(redis: Redis, event: JobProgressEvent): Promise<void> {
  await redis.publish(jobProgressChannel(event.jobId), JSON.stringify(event));
}

/** Clamps to the 0-100 the design doc's progress contract implies, and
 *  floors to an integer to match the `jobs.progress` INTEGER column. A
 *  handler reporting 150 or -5 is a handler bug, but it must not corrupt
 *  the row or confuse a subscribed client. */
export function normalizeProgress(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.floor(percent)));
}

import { collectDefaultMetrics, Registry } from "prom-client";

/**
 * One dedicated registry per process, not prom-client's own module-level
 * default `register` — keeps this package's metrics fully self-contained
 * (nothing else in a consuming app can accidentally register into, or
 * scrape, the same registry prom-client itself exports as a side effect of
 * merely importing it) and gives every metric definition in metrics.ts a
 * single explicit `registers: [registry]` home.
 */
export const registry = new Registry();

// Process-level metrics (CPU, memory, event loop lag, GC, open file
// descriptors) come for free from prom-client's own collector — a useful
// baseline every real deployment wants, even though the design doc's own
// metric list doesn't itemize it.
collectDefaultMetrics({ register: registry });

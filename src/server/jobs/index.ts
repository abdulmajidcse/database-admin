/**
 * The jobs subsystem (PLAN §7.3) and its WebSocket bridge (§2).
 *
 * Import the subsystem through this module — `import { jobManager } from
 * '../jobs'` — rather than reaching into ./manager directly: loading this file
 * is what registers the `jobs` channel, so a drawer that reopens after a page
 * reload gets a snapshot of everything still running plus the live tail.
 *
 * Keeping the bridge here (and not in the manager) means the manager stays a
 * plain event source that a unit test can drive without a WebSocket server.
 */

import { broadcast, registerChannel, sendTo } from '../ws/hub';
import { jobManager } from './manager';
import type { Job, JobEvent } from './types';

let attached = false;

/**
 * Idempotent, and called on import so no wiring step can be forgotten. Exported
 * as well so server.ts can attach it explicitly if it prefers.
 */
export function attachJobsChannel(): void {
  if (attached) return;
  attached = true;

  jobManager.subscribe((event: JobEvent, job: Readonly<Job>) => {
    // Two fan-outs because the hub keys subscriptions by (channel, connectionId):
    // the global jobs drawer subscribes without one, a per-connection panel with.
    broadcast('jobs', event);
    if (job.connectionId) broadcast('jobs', event, job.connectionId);
  });

  registerChannel('jobs', (client, connectionId) => {
    // §7.3 "the UI gets a jobs drawer that survives page reloads": a fresh socket
    // has missed every update so far, so hand it the current active set at once.
    for (const summary of jobManager.list({ connectionId, active: true, limit: 50 })) {
      sendTo(client, { type: 'job-update', job: summary });
    }
  });
}

attachJobsChannel();

export { JobManager, jobManager, toDetail, toSummary } from './manager';

export {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  type CancelHook,
  type CopyJobParams,
  type ExportDestination,
  type ExportJobParams,
  type ExportSource,
  type ImportJobParams,
  type Job,
  type JobChild,
  type JobContext,
  type JobEvent,
  type JobKind,
  type JobListOptions,
  type JobListener,
  type JobManagerOptions,
  type JobParams,
  type JobProgress,
  type JobRunner,
  type JobStatus,
  type RestoreJobParams,
  type RestoreOptions,
} from './types';

// Re-exported so a route can render a job without importing two modules.
export type { JobDetail, JobSummary } from '../../lib/api-types';

/** Immutable product resource admission. These limits bound retained transport
 * data/records, never truncate input, grant authority, change original image
 * counts or schema limits, or claim a whole-process heap ceiling. Capacity
 * failures are typed refusals. Sequential chunks retain native frame bounds.
 * Main request budget applies to the original image-free metadata projection.
 * Image bytes transfer independently; Daemon 64 MiB accommodates the original
 * eight 5 MiB decoded images (40 MiB). */
export const NATIVE_MAIN_PREPARATION_POLICY = Object.freeze({
  maxRequestBytes: 32 * 1024 * 1024,
  maxCheckpointBytes: 64 * 1024 * 1024,
  maxRetainedBytes: 256 * 1024 * 1024,
});
export const NATIVE_DAEMON_INVOCATION_POLICY = Object.freeze({
  maxTransferBytes: 64 * 1024 * 1024,
  maxRecords: 128,
});
export const NATIVE_PUBLIC_EVENT_POLICY = Object.freeze({
  maxRetainedBytes: 256 * 1024 * 1024,
  maxItems: 4096,
});

/** Original announced-card retention is 200. Completed observation history
 * may retire; pending/uncertain approvals must never be evicted. */
export const NATIVE_APPROVAL_OBSERVATION_POLICY = Object.freeze({ maxRecords: 200 });

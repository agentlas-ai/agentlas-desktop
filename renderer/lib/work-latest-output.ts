/**
 * Which output the Work screen presents when a conversation is reopened: the newest one.
 *
 * The right panel opens the last entry of the outputs the transcript's agent rows name (files their tool calls wrote, files
 * and servers their text names, their images). "Last" was the last row of the transcript, which is the newest only while the
 * rows are in time order. They are not: a run no answer anchors (it failed, was interrupted, or a Goal pass started it with no
 * prompt row) is drawn at the very end of the transcript whatever its time (TaskCockpit attachHydratedWorkProjections). Once the
 * long runs of a conversation hang on their answers, an older failed run drawn at the end would win over the newest answer's
 * output. So the order the panel reads is the order of time: each agent row carries when it happened and the outputs sort by
 * it. Rows without a time (a draft still streaming) are the newest, in the order they stand.
 */

/** When an agent row of the Work transcript happened: its run's end (an unbound run row) or its answer's creation. */
export function workRowRecencyMs(row: { createdAt?: string; startedAt?: number; finishedAt?: number }): number {
  if (typeof row.finishedAt === "number" && Number.isFinite(row.finishedAt)) return row.finishedAt;
  const created = row.createdAt ? Date.parse(row.createdAt) : NaN;
  if (Number.isFinite(created)) return created;
  if (typeof row.startedAt === "number" && Number.isFinite(row.startedAt)) return row.startedAt;
  return Number.POSITIVE_INFINITY;
}

/**
 * The outputs of every row, oldest row first (rows of the same time keep the transcript's order), each output once at the
 * place it first appears: the same de-duplication the transcript order used.
 */
export function outputsOldestToNewest<P extends { path?: string; fileUrl?: string }>(
  rows: ReadonlyArray<{ at: number; previews: readonly P[] }>,
): P[] {
  const ordered = rows.map((row, index) => ({ ...row, index }))
    .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at < b.at ? -1 : 1));
  const seen = new Set<string>();
  const out: P[] = [];
  for (const row of ordered) {
    for (const preview of row.previews) {
      const key = preview.path || preview.fileUrl || "";
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(preview);
    }
  }
  return out;
}

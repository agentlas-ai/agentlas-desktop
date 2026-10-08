export type LineDiffRow = {
  kind: "equal" | "add" | "remove";
  text: string;
  beforeLine: number | null;
  afterLine: number | null;
};

type Edit = { kind: LineDiffRow["kind"]; text: string };

function lines(content: string): string[] {
  if (!content) return [];
  const result = content.split("\n");
  if (result[result.length - 1] === "") result.pop();
  return result;
}

/** Myers line diff. A bounded fallback still displays every changed byte's line. */
function edits(before: string[], after: string[]): Edit[] {
  const frontier = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  let cells = 0;
  for (let distance = 0; distance <= before.length + after.length; distance++) {
    cells += frontier.size;
    if (cells > 1_000_000) return [
      ...before.map((text): Edit => ({ kind: "remove", text })),
      ...after.map((text): Edit => ({ kind: "add", text })),
    ];
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const left = frontier.get(diagonal - 1) ?? -Infinity;
      const right = frontier.get(diagonal + 1) ?? -Infinity;
      let x = diagonal === -distance || (diagonal !== distance && left < right) ? right : left + 1;
      if (!Number.isFinite(x)) x = 0;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) { x++; y++; }
      frontier.set(diagonal, x);
      if (x < before.length || y < after.length) continue;
      const result: Edit[] = [];
      x = before.length;
      y = after.length;
      for (let step = trace.length - 1; step >= 0; step--) {
        const previous = trace[step];
        const k = x - y;
        const previousK = k === -step || (k !== step && (previous.get(k - 1) ?? -Infinity) < (previous.get(k + 1) ?? -Infinity)) ? k + 1 : k - 1;
        const previousX = previous.get(previousK) ?? 0;
        const previousY = previousX - previousK;
        while (x > previousX && y > previousY) { result.push({ kind: "equal", text: before[--x] }); y--; }
        if (step === 0) break;
        if (x === previousX) result.push({ kind: "add", text: after[--y] });
        else result.push({ kind: "remove", text: before[--x] });
      }
      return result.reverse();
    }
  }
  return [];
}

export function diffLines(beforeContent: string, afterContent: string): LineDiffRow[] {
  const before = lines(beforeContent);
  const after = lines(afterContent);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const operations: Edit[] = [
    ...before.slice(0, prefix).map((text): Edit => ({ kind: "equal", text })),
    ...edits(before.slice(prefix, before.length - suffix), after.slice(prefix, after.length - suffix)),
    ...before.slice(before.length - suffix).map((text): Edit => ({ kind: "equal", text })),
  ];
  let beforeLine = 0;
  let afterLine = 0;
  return operations.map(({ kind, text }) => ({
    kind, text,
    beforeLine: kind === "add" ? null : ++beforeLine,
    afterLine: kind === "remove" ? null : ++afterLine,
  }));
}

export type SplitDiffRow = { before: LineDiffRow | null; after: LineDiffRow | null };

export function splitDiffRows(rows: LineDiffRow[]): SplitDiffRow[] {
  const result: SplitDiffRow[] = [];
  for (let index = 0; index < rows.length;) {
    const row = rows[index];
    if (row.kind === "equal") { result.push({ before: row, after: row }); index++; continue; }
    const removed: LineDiffRow[] = [];
    const added: LineDiffRow[] = [];
    while (index < rows.length && rows[index].kind !== "equal") {
      const next = rows[index++];
      (next.kind === "remove" ? removed : added).push(next);
    }
    for (let offset = 0; offset < Math.max(removed.length, added.length); offset++) result.push({ before: removed[offset] ?? null, after: added[offset] ?? null });
  }
  return result;
}

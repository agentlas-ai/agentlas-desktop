import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { McpInvocationEvent } from "../../shared/types";
import { userDataPath } from "../runtime-paths";
import { bindOneRuntimeToolArtifacts } from "../one/artifact-preview";
import { getCanonicalTask } from "../store/tasks";

/** Only the Main-owned relay calls this with pixels from its authorized guest. */
export function createNativeCapturePublisher(input: {
  task: { id: string; version: number } | null;
  chatId: string;
  runId: string;
  signal?: AbortSignal;
  emit: (event: McpInvocationEvent) => void;
}) {
  const retained = new Set<string>();
  let retainedBytes = 0;
  return (capture: { png: Buffer; isCurrent: () => boolean }): void => {
    // Long runs update Task metadata as workers report. Pin the current
    // version for this capture, not the version from invocation startup.
    // The task identity and live relay grant remain the authority boundary.
    const captureTask = input.task && getCanonicalTask(input.task.id);
    const current = () => {
      const task = input.task && getCanonicalTask(input.task.id);
      return !input.signal?.aborted && capture.isCurrent() && !!input.runId && !!task
        && !!captureTask && captureTask.version >= input.task!.version
        && task.originChatId === input.chatId && task.version === captureTask.version && task.status !== "archived";
    };
    if (!current()) throw new Error("native-browser-capture-stale");
    if (!Buffer.isBuffer(capture.png) || capture.png.length < 24 || capture.png.length > 24 * 1024 * 1024
      || !capture.png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error("native-browser-capture-empty");
    }
    // In-memory deduplication only; no image bytes or fingerprints enter logs.
    const digest = createHash("sha256").update(capture.png).digest("hex");
    if (retained.has(digest)) return;
    if (retainedBytes + capture.png.length > 256 * 1024 * 1024) throw new Error("native-browser-capture-budget-exceeded");
    // Canonicalize the Main-configured profile first: macOS /tmp is a normal
    // /private/tmp alias. Reject links below that trusted profile, not its OS alias.
    let dir = fs.realpathSync(userDataPath());
    for (const segment of ["generated-assets", "native-browser"]) {
      dir = path.join(dir, segment);
      try {
        const stat = fs.lstatSync(dir);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("native-browser-capture-stale");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        fs.mkdirSync(dir, { mode: 0o700 });
      }
      if (fs.realpathSync(dir) !== dir) throw new Error("native-browser-capture-stale");
    }
    const file = path.join(dir, `capture-${randomUUID()}.png`);
    let committed = false;
    try {
      fs.writeFileSync(file, capture.png, { flag: "wx", mode: 0o600 });
      if (!current()) throw new Error("native-browser-capture-stale");
      const task = captureTask!;
      const artifacts = bindOneRuntimeToolArtifacts({ taskId: task.id, taskVersion: task.version,
        chatId: input.chatId, runId: input.runId, toolId: `native-capture:${randomUUID()}`, paths: [file] });
      if (artifacts.length !== 1) throw new Error("native-browser-capture-unavailable");
      // No await between authority check, binding, and durable event ingestion.
      input.emit({ kind: "notice", notice: { level: "info", code: "native-browser-capture-bound",
        message: "브라우저 캡처를 저장했습니다." }, oneArtifacts: artifacts.map((artifact) => ({
          ...artifact, taskId: task.id, taskVersion: task.version, chatId: input.chatId, runId: input.runId,
        })) });
      committed = true;
      retained.add(digest);
      if (retained.size > 64) retained.delete(retained.values().next().value!);
      retainedBytes += capture.png.length;
    } finally {
      if (!committed) fs.rmSync(file, { force: true });
    }
  };
}

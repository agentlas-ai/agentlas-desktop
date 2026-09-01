import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type {
  ImportScienceDatasetCsvInput,
  ImportScienceDatasetCsvResult,
  ScienceDatasetTablePayload,
} from "../../shared/science-contract";
import { ScienceStore } from "./store";

const MAX_RAW_BYTES = 8 * 1024 * 1024;
const MAX_NORMALIZED_BYTES = 4 * 1024 * 1024;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }

function readRegularFileNoFollow(filePath: string): Buffer {
  let fd: number | null = null;
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > MAX_RAW_BYTES) throw new Error("science-dataset-raw-size-invalid");
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_RAW_BYTES + 1 - total));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_RAW_BYTES) throw new Error("science-dataset-raw-size-invalid");
      chunks.push(chunk.subarray(0, count));
    }
    const after = fs.fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || total !== before.size) {
      throw new Error("science-dataset-file-changed");
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("science-dataset-")) throw error;
    throw new Error("science-dataset-file-read-failed");
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}

async function runWorker(workerPath: string, jobRoot: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, path.join(jobRoot, "input.csv"), path.join(jobRoot, "output.json")], {
      cwd: jobRoot,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env: { ELECTRON_RUN_AS_NODE: "1", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TMPDIR: jobRoot },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { if (stderr.length < 4_096) stderr += String(chunk).slice(0, 4_096 - stderr.length); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("science-dataset-worker-timeout")); }, 30_000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("science-dataset-worker-spawn-failed")); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) resolve();
      else {
        const safeCode = stderr.trim().split(/\r?\n/, 1)[0];
        reject(new Error(/^science-dataset-[a-z0-9-]+$/.test(safeCode) ? safeCode : "science-dataset-worker-failed"));
      }
    });
  });
}

export class ScienceDatasetIngestionService {
  constructor(private readonly store: ScienceStore, private readonly workerPath = path.join(__dirname, "workers", "csv-to-table.js")) {}

  async importFile(filePath: string, input: ImportScienceDatasetCsvInput): Promise<ImportScienceDatasetCsvResult> {
    const rawBytes = readRegularFileNoFollow(filePath);
    let workerStat: fs.Stats;
    try { workerStat = fs.lstatSync(this.workerPath); }
    catch { throw new Error("science-dataset-worker-missing"); }
    if (!workerStat.isFile() || workerStat.isSymbolicLink()) throw new Error("science-dataset-worker-invalid");
    const workerSha256 = sha256(fs.readFileSync(this.workerPath));
    const environmentSha256 = sha256(canonicalJson({
      schema: "agentlas.science-dataset-environment/v1",
      workerSha256,
      runtime: "native-sidecar",
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      platform: process.platform,
      arch: process.arch,
      network: "denied",
      rawLimitBytes: MAX_RAW_BYTES,
      rowLimit: 5_000,
      normalizedLimitBytes: MAX_NORMALIZED_BYTES,
    }));
    const jobRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-science-dataset-")));
    if (process.platform !== "win32") fs.chmodSync(jobRoot, 0o700);
    try {
      fs.writeFileSync(path.join(jobRoot, "input.csv"), rawBytes, { flag: "wx", mode: 0o600 });
      await runWorker(this.workerPath, jobRoot);
      const outputPath = path.join(jobRoot, "output.json");
      const outputStat = fs.lstatSync(outputPath);
      if (!outputStat.isFile() || outputStat.isSymbolicLink() || outputStat.size < 2 || outputStat.size > MAX_NORMALIZED_BYTES) throw new Error("science-dataset-normalized-size-limit");
      let table: ScienceDatasetTablePayload;
      try { table = JSON.parse(fs.readFileSync(outputPath, "utf8")) as ScienceDatasetTablePayload; }
      catch { throw new Error("science-dataset-worker-output-invalid"); }
      const result = this.store.commitDatasetIngestion({
        requestId: input.requestId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        originMessageId: input.originMessageId,
        title: typeof input.title === "string" && input.title.trim() ? input.title : "Imported CSV dataset",
        rawBytes,
        table,
        workerSha256,
        environmentSha256,
      });
      return { canceled: false, ...result };
    } finally {
      try { fs.rmSync(jobRoot, { recursive: true, force: true }); } catch { /* private temp cleanup */ }
    }
  }
}

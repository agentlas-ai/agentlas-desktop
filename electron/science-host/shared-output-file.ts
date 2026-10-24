import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { userDataPath } from "../runtime-paths";

/** Common asset-root projection; the shared Task binder still supplies authority. */
export function writeScienceSharedOutputFile(family: "science-publications" | "science-artifacts", projectId: string, name: string, bytes: Buffer): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(projectId) || !/^[A-Za-z0-9_.-]{1,200}$/.test(name)
    || bytes.length < 1 || bytes.length > 64 * 1024 * 1024) throw new Error("science_shared_output_invalid");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const directory = userDataPath("generated-assets", family, projectId, digest);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(directory) !== path.resolve(directory)) throw new Error("science_shared_output_invalid");
  const output = path.join(directory, name);
  try { fs.writeFileSync(output, bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const checked = fs.openSync(output, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { if (!fs.fstatSync(checked).isFile() || createHash("sha256").update(fs.readFileSync(checked)).digest("hex") !== digest) throw new Error("science_shared_output_invalid"); }
  finally { fs.closeSync(checked); }
  return output;
}

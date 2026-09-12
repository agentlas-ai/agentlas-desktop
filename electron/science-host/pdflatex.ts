// Main-owned, pinned offline pdfLaTeX profiles. No PATH discovery or installer at render time.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { userDataPath } from "../runtime-paths";
import { analyzeLatexCompileLog, type LatexPdfInput, type ManuscriptPdfResult } from "./render-pdf";

export interface PdfLatexProfileRef { id: string; version: string; manifestSha256: string }
export interface PdfLatexFileReceipt { name: string; sha256: string }
export interface PdfLatexReceipt {
  engine: "pdflatex"; profile: PdfLatexProfileRef; version: string;
  executableSha256: string; packageManifestSha256: string; fontManifestSha256: string;
  formatSha256: string; inputManifestSha256: string; sandboxPolicySha256: string;
  passes: Array<{ pass: 1 | 2; exitCode: number; logSha256: string; auxSha256: string; recorderSha256: string; inputs: PdfLatexFileReceipt[] }>;
  referenceConverged: boolean;
}
interface ProfileManifest {
  schema: "agentlas.science.pdflatex-profile/v1";
  id: string; version: string; platform: string; engineVersion: string;
  executable: string; format: string;
  files: Array<PdfLatexFileReceipt & { kind: "binary" | "package" | "font" | "format" | "config" }>;
}
const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const hashJson = (value: unknown): string => digest(JSON.stringify(value));
function fail(code: string): never { throw new Error(code); }
const safeName = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.+-]+(?:\/[A-Za-z0-9_.+-]+)*$/u.test(value) && !value.split("/").some(part => part === "." || part === "..");
function validRef(value: unknown): value is PdfLatexProfileRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as PdfLatexProfileRef;
  return Object.keys(r).sort().join(",") === "id,manifestSha256,version" && typeof r.id === "string" && typeof r.version === "string" && typeof r.manifestSha256 === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(r.id) && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u.test(r.version) && /^[a-f0-9]{64}$/u.test(r.manifestSha256);
}
function within(root: string, file: string): boolean { return file === root || file.startsWith(root + path.sep); }
const defaultCache = (): string => userDataPath("science", "typeset-profiles");
async function fileDigest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 256 * 1024 })) hash.update(chunk);
  return hash.digest("hex");
}
async function loadProfile(ref: PdfLatexProfileRef, cache: string) {
  if (!validRef(ref)) fail("publication_pdf_profile_invalid");
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")) fail("publication_pdf_sandbox_unavailable");
  const directory = path.join(cache, ref.id, ref.version);
  if (!fs.existsSync(path.join(directory, "manifest.json"))) fail("publication_pdf_profile_missing");
  const realCache = fs.realpathSync(cache), realDirectory = fs.realpathSync(directory);
  if (!within(realCache, realDirectory)) fail("publication_pdf_profile_path_forbidden");
  const raw = fs.readFileSync(path.join(realDirectory, "manifest.json"));
  if (raw.length > 16_000_000 || digest(raw) !== ref.manifestSha256) fail("publication_pdf_profile_digest_mismatch");
  const manifest = JSON.parse(raw.toString("utf8")) as ProfileManifest;
  if (manifest.schema !== "agentlas.science.pdflatex-profile/v1" || manifest.id !== ref.id || manifest.version !== ref.version || manifest.platform !== process.platform || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 100_000 || typeof manifest.engineVersion !== "string") fail("publication_pdf_profile_invalid");
  const tree = fs.realpathSync(path.join(realDirectory, "tree"));
  if (!within(realDirectory, tree)) fail("publication_pdf_profile_path_forbidden");
  const files = new Map<string, ProfileManifest["files"][number]>();
  const realFiles = new Map<string, string>();
  for (const file of manifest.files) {
    if (!safeName(file.name) || !/^[a-f0-9]{64}$/u.test(file.sha256) || !["binary", "package", "font", "format", "config"].includes(file.kind) || files.has(file.name)) fail("publication_pdf_profile_invalid");
    const target = fs.realpathSync(path.join(tree, file.name));
    if (!within(tree, target) || !fs.statSync(target).isFile() || await fileDigest(target) !== file.sha256) fail("publication_pdf_profile_digest_mismatch");
    files.set(file.name, file); realFiles.set(target, file.sha256);
  }
  if (!safeName(manifest.executable) || !safeName(manifest.format) || files.get(manifest.executable)?.kind !== "binary" || files.get(manifest.format)?.kind !== "format") fail("publication_pdf_profile_invalid");
  return { manifest, tree, files, realFiles };
}
export async function probePdfLatexProfile(ref: PdfLatexProfileRef, cache = defaultCache()): Promise<{ available: boolean; reason: string | null; profile: PdfLatexProfileRef | null }> {
  try { const profile = await loadProfile(ref, cache); await assertSandboxSupport(profile.tree, cache); return { available: true, reason: null, profile: { ...ref } }; }
  catch (error) { return { available: false, reason: error instanceof Error && error.message.startsWith("publication_") ? error.message : "publication_pdf_profile_unavailable", profile: null }; }
}
function sandbox(tree: string, work: string, executable: string): string {
  // OS read policy is preventative; recorder validation below is additional provenance.
  const quote = (value: string): string => JSON.stringify(value);
  return `(version 1)(deny default)
(allow process-fork)(allow process-exec (literal ${quote(executable)}))
(allow sysctl-read)(allow mach-lookup)
(allow file-read-metadata)
(allow file-read* (literal "/") (subpath "/System/Volumes/Preboot/Cryptexes/OS") (subpath "/System/Cryptexes/OS") (literal ${quote(executable)}) (subpath "/System/Library") (subpath "/usr/lib") (subpath "/private/var/db/dyld") (literal "/dev/null") (subpath ${quote(tree)}) (subpath ${quote(work)}))
(allow file-write* (literal "/dev/null") (subpath ${quote(work)}))`;
}
async function assertSandboxSupport(tree: string, cache: string): Promise<void> {
  const scratch = fs.mkdtempSync(path.join(cache, ".sandbox-probe-"));
  try {
    const work = path.join(scratch, "work"); fs.mkdirSync(work);
    const allowed = path.join(work, "allowed.txt"), denied = path.join(scratch, "denied.txt");
    fs.writeFileSync(allowed, "sandbox-control"); fs.writeFileSync(denied, "sandbox-sentinel");
    const policy = sandbox(tree, fs.realpathSync(work), "/bin/cat");
    const run = async (file: string) => {
      try { const result = await promisify(execFile)("/usr/bin/sandbox-exec", ["-p", policy, "/bin/cat", file], { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin", HOME: work } }); return { ok: true, stdout: result.stdout }; }
      catch (error) { return { ok: false, stdout: typeof (error as { stdout?: unknown }).stdout === "string" ? (error as { stdout: string }).stdout : "" }; }
    };
    const control = await run(allowed), negative = await run(denied);
    if (!control.ok || control.stdout !== "sandbox-control" || negative.ok || negative.stdout.includes("sandbox-sentinel")) fail("publication_pdf_sandbox_unavailable");
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
function execute(executable: string, args: string[], work: string, env: NodeJS.ProcessEnv, policy: string, timeout: number): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", policy, executable, ...args], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", done = false;
    const finish = (code: number): void => { if (done) return; done = true; clearTimeout(timer); resolve({ code, output }); };
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    const collect = (bytes: Buffer): void => { output += bytes.toString("utf8"); if (output.length > 2_000_000) { output = output.slice(-2_000_000); child.kill("SIGKILL"); } };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.once("error", () => finish(-1)); child.once("close", code => finish(code ?? -1));
  });
}
/** Two fixed passes. Unsupported/missing profiles and failed convergence never print a fallback. */
export async function renderPdfWithPdfLatex(input: LatexPdfInput, ref: PdfLatexProfileRef | undefined, cache = defaultCache()): Promise<ManuscriptPdfResult> {
  let work: string | null = null;
  let receipt: PdfLatexReceipt | undefined;
  const typesetFiles: Array<{ name: string; bytes: Uint8Array }> = [];
  let finalLog = "";
  try {
    if (!ref) fail("publication_pdf_profile_required");
    const { manifest, tree, files, realFiles } = await loadProfile(ref, cache);
    await assertSandboxSupport(tree, cache);
    const jobs = path.join(cache, ".jobs"); fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
    work = fs.realpathSync(fs.mkdtempSync(path.join(jobs, "render-")));
    const inputs = new Map<string, string>();
    const writeInput = (name: string, bytes: string | Uint8Array): void => {
      if (!safeName(name) || name.split("/").some(part => part.startsWith(".")) || inputs.has(name) || (name !== "main.tex" && /\.(?:aux|log|fls|fmt|cnf|out|toc)$/iu.test(name))) fail("publication_pdf_input_path_forbidden");
      const target = path.join(work!, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o400 }); inputs.set(name, digest(bytes));
    };
    writeInput("main.tex", input.tex);
    if (input.files.length > 1000) fail("publication_pdf_input_limit");
    for (const file of input.files) writeInput(file.name, file.bytes);
    const executable = fs.realpathSync(path.join(tree, manifest.executable));
    const policy = sandbox(tree, work, executable);
    receipt = { engine: "pdflatex", profile: { ...ref }, version: manifest.engineVersion, executableSha256: files.get(manifest.executable)!.sha256,
      packageManifestSha256: hashJson(manifest.files.filter(f => f.kind === "package").sort((a,b) => a.name.localeCompare(b.name))),
      fontManifestSha256: hashJson(manifest.files.filter(f => f.kind === "font").sort((a,b) => a.name.localeCompare(b.name))),
      formatSha256: files.get(manifest.format)!.sha256, inputManifestSha256: hashJson([...inputs].sort()), sandboxPolicySha256: digest(policy.split(tree).join("<profile>").split(work).join("<job>")), passes: [], referenceConverged: false };
    const env: NodeJS.ProcessEnv = { PATH: path.dirname(executable), HOME: work, TMPDIR: work, LANG: "C", LC_ALL: "C", TZ: "UTC",
      TEXMFROOT: tree, TEXMFCNF: path.join(tree, "texmf-dist", "web2c"), TEXMF: `{${tree}/texmf-config,${tree}/texmf-var,${tree}/texmf-dist}`,
      TEXMFHOME: work, TEXMFCONFIG: path.join(tree,"texmf-config"), TEXMFVAR: path.join(tree,"texmf-var"), TEXMFSYSCONFIG: path.join(tree,"texmf-config"), TEXMFSYSVAR: path.join(tree,"texmf-var"),
      TEXMFOUTPUT: work, TEXMF_CACHE: work, openin_any: "p", openout_any: "p", shell_escape: "f", MKTEXFMT: "0", MKTEXPK: "0", MKTEXTFM: "0", MKTEXMF: "0", MKTEXTEX: "0" };
    const args = ["-progname=pdflatex", `-fmt=${path.join(tree,manifest.format)}`, "-no-shell-escape", "-cnf-line=max_print_line=10000", "-no-mktex=fmt", "-no-mktex=pk", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "-recorder", "main.tex"];
    const sanitize = (text: string): string => text.split(tree).join("<profile>").split(work!).join("<job>");
    let previousAux: string | null = null;
    for (const pass of [1, 2] as const) {
      const run = await execute(executable, args, work, env, policy, Math.min(240_000, Math.max(1000, input.timeoutMs ?? 120_000)));
      const read = (name: string): string => fs.existsSync(path.join(work!,name)) ? fs.readFileSync(path.join(work!,name),"utf8") : "";
      const rawLog = read("main.log") || run.output, rawRecorder = read("main.fls");
      finalLog = sanitize(rawLog);
      const observed: PdfLatexFileReceipt[] = [];
      for (const line of rawRecorder.split(/\r?\n/u)) {
        if (!line.startsWith("INPUT ") && !line.startsWith("OUTPUT ")) continue;
        const output = line.startsWith("OUTPUT "), rawPath = line.slice(output ? 7 : 6), target = path.resolve(work,rawPath);
        if (!fs.existsSync(target)) { if (!output) fail("publication_pdf_recorder_unresolved"); continue; }
        const real = fs.realpathSync(target);
        if (output && !within(work,real)) fail("publication_pdf_write_forbidden");
        if (!output) {
          const name = within(tree,real) ? `profile/${path.relative(tree,real)}` : within(work,real) ? `input/${path.relative(work,real)}` : fail("publication_pdf_read_forbidden");
          const sha = digest(fs.readFileSync(real));
          if (name.startsWith("profile/") && realFiles.get(real) !== sha) fail("publication_pdf_unpinned_resource");
          if (!observed.some(f => f.name === name)) observed.push({ name, sha256: sha });
        }
      }
      for (const [name, sha] of inputs) if (digest(fs.readFileSync(path.join(work,name))) !== sha) fail("publication_pdf_input_modified");
      const aux = ["main.aux", "main.out", "main.toc"].map(name => ({name, content: sanitize(read(name))}));
      const auxDigest = hashJson(aux);
      for (const [suffix, content] of [["log",finalLog],["fls",sanitize(rawRecorder)],["aux.json",JSON.stringify(aux)]] as const) typesetFiles.push({name:`typeset/pass-${pass}.${suffix}`,bytes:Buffer.from(content)});
      receipt.passes.push({pass,exitCode:run.code,logSha256:digest(finalLog),auxSha256:auxDigest,recorderSha256:digest(sanitize(rawRecorder)),inputs:observed.sort((a,b)=>a.name.localeCompare(b.name))});
      if (run.code !== 0) fail("publication_pdf_compile_failed");
      if (!rawRecorder || !read("main.aux")) fail("publication_pdf_evidence_missing");
      if (pass === 2) receipt.referenceConverged = auxDigest === previousAux;
      previousAux = auxDigest;
    }
    const diagnostics = analyzeLatexCompileLog(finalLog);
    if (!receipt.referenceConverged || diagnostics.undefinedReferenceCount || diagnostics.multiplyDefinedLabelCount || diagnostics.rerunWarningCount) fail("publication_pdf_references_unconverged");
    if (diagnostics.missingGlyphCount) fail("publication_pdf_glyph_missing");
    // Detect cache mutation across the execution window as well as before dispatch.
    await loadProfile(ref,cache);
    const bytes = fs.readFileSync(path.join(work,"main.pdf"));
    if (bytes.length < 100 || !bytes.subarray(0,5).equals(Buffer.from("%PDF-"))) fail("publication_pdf_bytes_invalid");
    typesetFiles.push({name:"typeset/receipt.json",bytes:Buffer.from(JSON.stringify(receipt,null,2))});
    return {ok:true,engine:"pdflatex",bytes,log:finalLog,diagnostics,toolchain:receipt,typesetFiles};
  } catch (error) {
    return {ok:false,engine:"pdflatex",reason:error instanceof Error && error.message.startsWith("publication_") ? error.message : "publication_pdf_execution_failed",log:finalLog,diagnostics:analyzeLatexCompileLog(finalLog),toolchain:receipt,typesetFiles};
  } finally { if(work) fs.rmSync(work,{recursive:true,force:true}); }
}

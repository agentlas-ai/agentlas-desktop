import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { scienceStore } from "agentlas-science";
import { userDataPath } from "../runtime-paths";
import { recordRunProducedFiles } from "../harness/run-produced-files";
import { writeScienceSharedOutputFile } from "./shared-output-file";

interface SciencePublicationOutputs {
  projectId: string; invocationRunId: string; operationId: string;
  manuscriptId: string; manuscriptVersion: number; manuscriptContentSha256: string;
  files: Array<{ name: string; path: string; sha256: string; sizeBytes: number }>;
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const within = (root: string, file: string) => { const relative = path.relative(root, file); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const fail = (): never => { throw new Error("science_publication_output_scope_changed"); };

/** Copies exact verified publication bytes to the existing common asset root.
 * The canonical research delivery remains owned by Science; the common Task
 * binder supplies its ordinary hash seal, preview and 90-day binding index. */
export function recordSciencePublicationHostOutputs(input: SciencePublicationOutputs): number {
  const store = scienceStore(), turn = store.getTurnByInvocationRunId(input.invocationRunId);
  const binding = turn && store.getConversationRuntimeBinding(input.projectId, turn.conversationId);
  const manuscript = store.getManuscriptVersionForProject(input.projectId, input.manuscriptId, input.manuscriptVersion);
  if (!turn || turn.projectId !== input.projectId || turn.status !== "running" || !binding
    || binding.runtimeChatId !== turn.runtimeChatId || !manuscript
    || manuscript.contentSha256 !== input.manuscriptContentSha256 || !Array.isArray(input.files) || input.files.length > 8) return fail();
  store.assertScienceTurnExecutionAuthority(turn);
  const allowed = [userDataPath("extensions", "agentlas-science", "manuscript-renders", input.projectId),
    userDataPath("extensions", "agentlas-science", "publication-jobs", input.projectId),
    userDataPath("extensions", "agentlas-science", "submission-exports", "sha256")].map(root => path.resolve(root));
  const outputs: string[] = [];
  for (const file of input.files) {
    if (!/^(?:manuscript\.(?:html|tex|docx|pdf|md|hwpx)|references\.bib|submission\.zip)$/.test(file.name)
      || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0 || file.sizeBytes > 64 * 1024 * 1024
      || !path.isAbsolute(file.path) || fs.realpathSync(file.path) !== path.resolve(file.path)
      || !allowed.some(root => within(root, file.path))) return fail();
    const fd = fs.openSync(file.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== file.sizeBytes) return fail();
      bytes = fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
    if (sha(bytes) !== file.sha256) return fail();
    outputs.push(writeScienceSharedOutputFile("science-publications", input.projectId, file.name, bytes));
  }
  store.assertScienceTurnExecutionAuthority(store.getTurnByInvocationRunId(input.invocationRunId) ?? turn);
  return recordRunProducedFiles(input.invocationRunId, input.operationId, outputs);
}

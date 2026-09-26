// Writes one mail attachment to a folder the caller chose (Main only).
// The file name comes from a stranger's email, so it is reduced to a plain
// basename and never overwrites an existing file.
import fs from "node:fs";
import path from "node:path";
import { agentMailFetchAttachment } from "./client";
import type { AgentMailResult } from "../../shared/agent-mail";

const MAX_NAME = 120;

export function safeAttachmentName(raw: string | null, index: number): string {
  const base = path.basename(String(raw ?? "").replace(/\\/g, "/"))
    // control chars, path and shell-hostile characters
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  const name = base || `attachment-${index + 1}`;
  if (name.length <= MAX_NAME) return name;
  const ext = path.extname(name).slice(0, 16);
  return `${name.slice(0, MAX_NAME - ext.length)}${ext}`;
}

function uniquePath(directory: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(directory, name);
  for (let n = 2; fs.existsSync(candidate) && n < 1000; n += 1) {
    candidate = path.join(directory, `${stem} (${n})${ext}`);
  }
  return candidate;
}

export async function saveAgentMailAttachment(
  messageId: string,
  index: number,
  directory: string,
): Promise<AgentMailResult<{ path: string; bytes: number; filename: string }>> {
  const fetched = await agentMailFetchAttachment(messageId, index);
  if (!fetched.ok) return fetched;
  const resolvedDir = path.resolve(directory);
  fs.mkdirSync(resolvedDir, { recursive: true });
  const filename = safeAttachmentName(fetched.filename, index);
  const target = uniquePath(resolvedDir, filename);
  // The target must stay inside the chosen folder even after name cleanup.
  if (path.dirname(target) !== resolvedDir) {
    return { ok: false, code: "agent_mail_attachment_name_invalid", message: "The attachment name is not usable.", status: null };
  }
  fs.writeFileSync(target, fetched.bytes, { flag: "wx", mode: 0o600 });
  return { ok: true, path: target, bytes: fetched.bytes.length, filename: path.basename(target) };
}

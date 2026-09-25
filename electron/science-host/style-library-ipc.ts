/**
 * Science style library: Word/한글 documents a person uploads so papers and reports can be written like them.
 * Main owns the native parts (file picker, opening the sample in Word); Science owns parsing, rendering and storage.
 *
 * Owner 2026-09-25: an uploaded paper or report is saved to a list; clicking it shows a sample document in that style
 * (filler text, tables, a chart, headings) rather than its parsed structure as code, and the person edits it like a
 * Word file and saves it back as the style.
 */
import fs from "node:fs";
import path from "node:path";
import { BrowserWindow, dialog, shell, type IpcMain, type IpcMainInvokeEvent } from "electron";
import type { ProductExtensionPermission } from "../../shared/product-extension";
import type { ScienceDaemonClient } from "./daemon-client";

export const SCIENCE_STYLE_LIBRARY_IPC_CHANNELS = [
  "science:styles:list", "science:styles:import", "science:styles:rename", "science:styles:delete",
  "science:styles:applyToProject", "science:styles:samplePreview", "science:styles:openForEditing", "science:styles:saveEdited",
] as const;

const MAX_STYLE_BYTES = 64 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const sha = (value: unknown): string => { if (typeof value !== "string" || !SHA.test(value)) throw new Error("science-style-id-invalid"); return value; };
const lang = (value: unknown): "ko" | "en" => value === "en" ? "en" : "ko";

export function registerScienceStyleLibraryIpc({ ipc, assertScienceSender, client }: {
  ipc: Pick<IpcMain, "handle">;
  assertScienceSender(event: IpcMainInvokeEvent, envelope: unknown, permission?: ProductExtensionPermission): unknown;
  client: Pick<ScienceDaemonClient, "command" | "commandObserved">;
}): void {
  const handle = (channel: typeof SCIENCE_STYLE_LIBRARY_IPC_CHANNELS[number], fn: (event: IpcMainInvokeEvent, input: Row) => unknown,
    permission: ProductExtensionPermission = "science:projects") => {
    ipc.handle(channel, async (event, envelope: unknown) => {
      assertScienceSender(event, envelope, permission);
      if (event.senderFrame !== event.sender.mainFrame) throw new Error("science-style-subframe-denied");
      return fn(event, row(row(envelope).input));
    });
  };
  handle("science:styles:list", () => client.commandObserved({ op: "styles.list" }));
  handle("science:styles:import", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = { properties: ["openFile"], filters: [{ name: "Word / 한글", extensions: ["docx", "dotx", "docm", "dotm", "hwpx"] }] };
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
    const file = picked.filePaths[0];
    const size = fs.statSync(file).size;
    if (size < 1 || size > MAX_STYLE_BYTES) throw new Error("science-style-file-size-invalid");
    return client.command({ op: "styles.import", input: { bytesBase64: fs.readFileSync(file).toString("base64"), fileName: path.basename(file) } });
  }, "science:artifacts");
  handle("science:styles:rename", (_event, input) => {
    const name = typeof input.name === "string" ? input.name.trim().slice(0, 120) : "";
    if (!name) throw new Error("science-style-name-invalid");
    return client.command({ op: "styles.rename", input: { sha256: sha(input.sha256), name } });
  }, "science:artifacts");
  handle("science:styles:delete", (_event, input) => client.command({ op: "styles.delete", input: { sha256: sha(input.sha256) } }), "science:artifacts");
  handle("science:styles:applyToProject", (_event, input) => {
    if (typeof input.projectId !== "string" || !input.projectId) throw new Error("science-style-project-invalid");
    return client.command({ op: "styles.applyToProject", input: { sha256: sha(input.sha256), projectId: input.projectId } });
  }, "science:artifacts");
  handle("science:styles:samplePreview", (_event, input) => client.commandObserved({ op: "styles.samplePreview", input: { sha256: sha(input.sha256), lang: lang(input.lang) } }));
  handle("science:styles:openForEditing", async (_event, input) => {
    const result = row(await client.command({ op: "styles.openForEditing", input: { sha256: sha(input.sha256), lang: lang(input.lang) } }));
    const file = typeof result.path === "string" ? path.resolve(result.path) : "";
    // Only the sample Science just wrote may be opened: a .docx inside its style-library-edits folder.
    if (!file.endsWith(".docx") || path.basename(path.dirname(file)) !== "style-library-edits" || !fs.existsSync(file)) throw new Error("science-style-edit-path-invalid");
    const error = await shell.openPath(file);
    if (error) throw new Error(`science-style-open-failed:${error}`);
    return { opened: true, fileName: path.basename(file) };
  }, "science:artifacts");
  handle("science:styles:saveEdited", (_event, input) => client.command({ op: "styles.saveEdited", input: { sha256: sha(input.sha256) } }), "science:artifacts");
}

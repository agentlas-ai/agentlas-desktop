/*
 * The read-only file preview protocol (electron/document/file-preview.ts serves it): the host name of
 * agentlas://file-preview/<token> and the kinds the Universal File Viewer renders from it. A token is the only thing a
 * renderer ever holds; a path never reaches it.
 */

export const FILE_PREVIEW_HOST = "file-preview";
export const FILE_PREVIEW_URL_PREFIX = `agentlas://${FILE_PREVIEW_HOST}/`;

export type FilePreviewKind = "document" | "pdf" | "spreadsheet" | "presentation";

export function filePreviewUrl(token: string): string {
  return `${FILE_PREVIEW_URL_PREFIX}${token}`;
}

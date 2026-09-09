import { net } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Next's static export writes one Flight/RSC sidecar next to every HTML page.
 * Electron's file fetch correctly infers those `.txt` files as `text/plain`,
 * but the App Router only accepts the sidecar as a Flight response when its
 * content type starts with `text/x-component`.
 */
export function rendererResourceMimeType(filePath: string): string | null {
  return path.extname(filePath).toLowerCase() === ".txt" ? "text/x-component" : null;
}

/** Fetch a renderer asset while preserving the stream and correcting RSC metadata. */
export async function fetchRendererResource(filePath: string): Promise<Response> {
  const response = await net.fetch(pathToFileURL(filePath).toString());
  const mimeType = rendererResourceMimeType(filePath);
  if (!mimeType || !response.ok || !response.body) return response;

  const headers = new Headers(response.headers);
  headers.set("content-type", mimeType);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

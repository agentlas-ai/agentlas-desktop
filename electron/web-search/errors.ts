/** The closed error codes of the web_search / web_read tools. The model reads them as the first word of the error text. */
export type WebToolErrorCode = "search_blocked" | "search_failed" | "address_refused" | "page_failed" | "timed_out";

export class WebToolError extends Error {
  constructor(readonly code: WebToolErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "WebToolError";
  }
}

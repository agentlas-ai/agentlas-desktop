/** A composer request rejected before the daemon inspects or changes Science state. */
export const SCIENCE_START_INVALID_ID_BEFORE_ADMISSION =
  "science_start_invalid_id_before_admission";

// Keep the same accepted UUID versions and variant as the Science store.
const SCIENCE_REQUEST_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function assertScienceComposerRequestId(requestId: unknown): void {
  if (typeof requestId !== "string" || !SCIENCE_REQUEST_UUID.test(requestId)) {
    throw Object.assign(new Error("science-request-id-invalid"), {
      code: SCIENCE_START_INVALID_ID_BEFORE_ADMISSION,
    });
  }
}

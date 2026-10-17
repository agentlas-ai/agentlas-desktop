import type { LiveDocumentFormat } from "../../../shared/live-document";
import type { LiveDocumentCodec } from "./common";
import { docxCodec } from "./docx";
import { hwpCodec } from "./hwp";
import { hwpxCodec } from "./hwpx";
import { pptxCodec } from "./pptx";
import { xlsxCodec } from "./xlsx";

export const LIVE_DOCUMENT_CODECS: Record<LiveDocumentFormat, LiveDocumentCodec> = {
  xlsx: xlsxCodec,
  docx: docxCodec,
  pptx: pptxCodec,
  hwpx: hwpxCodec,
  hwp: hwpCodec,
};

export { LiveDocumentCodecError } from "./common";

/** Measured bytes and decode evidence, independent of provider completion. */
export interface MediaOutputVerification {
  schemaVersion: "agentlas.media-output.v1";
  sha256: string;
  sizeBytes: number;
  container: string;
  video: { codec: string; width: number; height: number; durationSec: number; decodedFrames: number };
  audio: { present: boolean; codec?: string; channels?: number };
  criteria: { durationSec?: number; aspectRatio?: "16:9" | "9:16" | "1:1"; minWidth?: number; minHeight?: number; requireAudio?: boolean };
  engines: Array<{ name: "ffmpeg" | "ffprobe"; sha256: string; version: string }>;
  verifiedAt: string;
}

/**
 * The largest chat video the phone bridge serves, for BOTH sources: a video stored with a chat message (chat-video-transfers.ts, read from the
 * chat store) and a video found in a folder the chat shows (legacy-chat-video.ts, read from disk). They carried 64 MiB and 192 MiB, so the same
 * video played on one phone build and was refused on another. 192 MiB is the number the other video paths
 * already use (one/artifact-preview.ts MAX_VIDEO_BYTES, daemon/science-video.ts LIMIT, the `science-video-large-v1` capability).
 * basis: 측정 + 계산. A 192 MiB video is 192 chunks of 1 MiB: one transfer fits a phone's request window beside other traffic (test-mobile-video-chunk-budget: 192 chunks
 * pass beside 30 other requests; the cap is now 300 per minute, relay refusal instead of a closed socket). Cost measured on this Mac
 * (evidence/desktop-values-s56/out-blob-substr-cost.json, `substr(data, off, 1 MiB)` on the stored blob, which the store path reads once per chunk and once more
 * to prepare): 12 ms per chunk at 64 MiB, 38 ms at 192 MiB (the whole blob is read each time: cost grows with size squared), 15 s of reads in all for one 192 MiB video,
 * about 130 MiB of transient memory, each read blocking Main for at most about 43 ms.
 * Reached: a larger video is refused before any byte is sent (chat_video_unavailable from the store path, chat_file_too_large from the disk path) and
 * stays watchable on the desktop; a 192 MiB stored video makes the desktop window stutter in 40 ms steps while it transfers.
 */
export const CHAT_VIDEO_MAX_BYTES = 192 * 1024 * 1024;

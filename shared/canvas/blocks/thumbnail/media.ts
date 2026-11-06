import { num, optionalNum, optionalText, text } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { FAINT, INK, KINDS, MUTED, badgeOf, circle, fileFields, fit, hash, optList, rect, rng, tile, tileCss, tw, txt } from "./_shared";
import { sceneField, scenePicture, sceneOf } from "./_scenes";

/** The media files: a photo, a video frame and an audio waveform. */

/** The soft dark edge that makes a drawn scene read as a photograph. */
const vignette = (u: string) => `<defs><radialGradient id="${u}-vg" cx=".5" cy=".5" r=".75"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".3"/></radialGradient></defs><rect width="400" height="195" fill="url(#${u}-vg)"/>`;
const pill = (x: number, y: number, label: string, size: number, fill: string, ink = "#fff", right = false) => { const w = tw(label, size, true) + 12, x0 = right ? x - w : x; return rect(x0, y, w, size + 8, fill, { rx: (size + 8) / 2 }) + txt(x0 + w / 2, y + size + 1.2, label, size, { fill: ink, w: 800, anchor: "middle" }); };

// ---- image_file -------------------------------------------------------------------------------------------------------------------------
export const imageFile = defineAsset({
  type: "image_file", category: "thumbnail", width: "third", frame: "thumb",
  use: "An image or photo as a preview tile: a drawn scene (sunset, mountains, ocean, city, forest, abstract) with its caption and pixel size.",
  useKo: "이미지·사진을 미리보기 타일로 보여줍니다: 장면(노을·산·바다·도시·숲·추상)을 그린 그림과 캡션, 픽셀 크기.",
  tags: ["image", "photo", "picture", "png", "jpg", "thumbnail", "이미지", "사진", "그림", "썸네일"],
  notes: "scene is one word: sunset, mountains, ocean, city, forest or abstract (it is a drawing in that mood, not the real picture). caption is overlaid on the picture; dimensions like 4032×3024.",
  fields: { ...fileFields, scene: sceneField, caption: optionalText(60), dimensions: optionalText(16) },
  sample: { name: "Lisbon-sunset-0412.jpg", scene: "sunset", caption: "Golden hour over the Tagus", dimensions: "4032×3024", size: "3.2 MB", modified: "Oct 12" },
  render(b, { uid }) {
    let s = scenePicture(sceneOf(b.scene, b.name), uid) + vignette(uid);
    if (b.caption) s += `<defs><linearGradient id="${uid}-sc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".6"/></linearGradient></defs><rect y="132" width="400" height="63" fill="url(#${uid}-sc)"/>${txt(14, 180, fit(b.caption, 11.5, 372, true), 11.5, { fill: "#fff", w: 700 })}`;
    return tile({ label: badgeOf(b.name, "image"), name: b.name, meta: [b.dimensions, b.size, b.modified], svg: s });
  },
  summary: b => `Image ${b.name}${b.dimensions ? `, ${b.dimensions}` : ""}${b.size ? `, ${b.size}` : ""}${b.caption ? `. ${b.caption}` : ""}.`,
  css: tileCss("image_file", KINDS.image.color),
});

// ---- video_file -------------------------------------------------------------------------------------------------------------------------
export const videoFile = defineAsset({
  type: "video_file", category: "thumbnail", width: "third", frame: "thumb",
  use: "A video as a preview tile: a dark frame with a scene, a play button, the running time and a progress bar.",
  useKo: "영상을 미리보기 타일로 보여줍니다: 장면이 있는 어두운 화면, 재생 버튼, 재생 시간, 진행 막대.",
  tags: ["video", "movie", "clip", "mp4", "recording", "thumbnail", "영상", "동영상", "비디오", "썸네일"],
  notes: "duration like 12:48; progress is how far it was watched, 0-100 (leave out for a bar-less frame); scene picks the drawn frame; resolution like 4K.",
  fields: { ...fileFields, duration: text(10), scene: sceneField, progress: optionalNum, resolution: optionalText(8) },
  sample: { name: "Product-demo-walkthrough.mp4", duration: "12:48", scene: "city", progress: 38, resolution: "4K", size: "412 MB", modified: "Oct 9" },
  render(b, { uid }) {
    const p = b.progress === undefined ? undefined : Math.min(100, Math.max(0, b.progress)), dw = tw(b.duration, 10.5, true) + 14;
    let s = scenePicture(sceneOf(b.scene, b.name), uid) + rect(0, 0, 400, 195, "#070d14", { opacity: 0.36 }) + vignette(uid);
    s += circle(200, 94, 36, "none", { stroke: "#fff", sw: 1.6, opacity: 0.4 }) + circle(200, 94, 27, "#fff", { opacity: 0.94 }) + `<path d="M193 81.5 215 94 193 106.5Z" fill="${INK}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`;
    if (b.resolution) s += pill(12, 12, b.resolution, 9.5, "rgba(7,13,20,.62)");
    s += rect(388 - dw, p === undefined ? 168 : 160, dw, 18.5, "rgba(7,13,20,.7)", { rx: 5 }) + txt(388 - dw / 2, (p === undefined ? 168 : 160) + 13.2, b.duration, 10.5, { fill: "#fff", w: 800, anchor: "middle" });
    if (p !== undefined) s += rect(0, 188, 400, 7, "#fff", { opacity: 0.28 }) + rect(0, 188, (400 * p) / 100, 7, "#ff4d6d") + circle(Math.min(396, Math.max(4, (400 * p) / 100)), 191.5, 5, "#fff");
    return tile({ label: badgeOf(b.name, "video"), name: b.name, meta: [b.duration, b.resolution, b.size, b.modified], svg: s });
  },
  summary: b => `Video ${b.name}, ${b.duration}${b.resolution ? `, ${b.resolution}` : ""}${b.size ? `, ${b.size}` : ""}${b.progress !== undefined ? `, watched ${Math.round(b.progress)}%` : ""}.`,
  css: tileCss("video_file", KINDS.video.color),
});

// ---- audio_file -------------------------------------------------------------------------------------------------------------------------
const BARS = 58;
/** BARS bar heights (0.08-1): the supplied peaks averaged into place, or a smooth pseudo waveform drawn from the name (the same name always gives the same shape). */
function waveform(peaks: number[] | undefined, name: string): number[] {
  const real = (peaks ?? []).map(v => Math.abs(v)), max = Math.max(0, ...real);
  if (real.length >= 2 && max > 0) return Array.from({ length: BARS }, (_, i) => { const a = Math.floor((i * real.length) / BARS), z = Math.max(a + 1, Math.floor(((i + 1) * real.length) / BARS)), seg = real.slice(a, z); return Math.max(0.08, seg.reduce((s, v) => s + v, 0) / seg.length / max); });
  const rand = rng(hash(name)), p1 = rand() * 6, p2 = rand() * 6, p3 = rand() * 6;
  return Array.from({ length: BARS }, (_, i) => Math.min(1, Math.max(0.09, (0.46 + 0.28 * Math.sin(i * 0.19 + p1) + 0.18 * Math.sin(i * 0.53 + p2) + 0.08 * Math.sin(i * 1.3 + p3)) * (0.62 + 0.5 * rand()))));
}
const seconds = (d: string) => { const m = d.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/); return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined; };
const clock = (n: number) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}`;

export const audioFile = defineAsset({
  type: "audio_file", category: "thumbnail", width: "third", frame: "thumb",
  use: "An audio file as a preview tile: a waveform with the track title, the artist and the running time.",
  useKo: "오디오 파일을 미리보기 타일로 보여줍니다: 파형과 곡 제목, 아티스트, 재생 시간.",
  tags: ["audio", "music", "song", "podcast", "waveform", "mp3", "오디오", "음악", "팟캐스트", "파형"],
  notes: "peaks are optional loudness values (any scale, up to 64, resampled); without them a waveform is drawn from the file name. duration like 3:42.",
  fields: { ...fileFields, title: optionalText(50), artist: optionalText(40), duration: text(10), peaks: optList(num, 0, 64), progress: optionalNum },
  sample: { name: "Interview-with-Dana-Reyes.m4a", title: "Building in public", artist: "The Maker Hour · Ep. 42", duration: "42:18", progress: 36, size: "38.5 MB", modified: "Oct 20", peaks: [0.2, 0.35, 0.5, 0.4, 0.62, 0.75, 0.55, 0.8, 0.9, 0.7, 0.45, 0.6, 0.85, 1, 0.78, 0.5, 0.38, 0.55, 0.72, 0.6, 0.42, 0.3, 0.5, 0.68, 0.82, 0.6, 0.4, 0.28, 0.45, 0.66, 0.74, 0.52, 0.36, 0.5, 0.7, 0.88, 0.64, 0.4, 0.3, 0.22] },
  render(b, { uid }) {
    const bars = waveform(b.peaks, b.name), p = Math.min(100, Math.max(0, b.progress ?? 0)) / 100, x0 = 20, pitch = 6.2, cy = 124, played = "#e6347a", rest = "#f3b9d0";
    const title = b.title ?? b.name.replace(/\.[A-Za-z0-9]{1,5}$/, ""), total = seconds(b.duration);
    let s = `<defs><linearGradient id="${uid}-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff0f5"/><stop offset="1" stop-color="#f7f8f7"/></linearGradient><linearGradient id="${uid}-art" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff7aa8"/><stop offset="1" stop-color="#7048e8"/></linearGradient></defs>${rect(0, 0, 400, 195, `url(#${uid}-bg)`)}`;
    s += rect(20, 16, 46, 46, `url(#${uid}-art)`, { rx: 9 }) + `<path d="M48 27v16.2a5 5 0 1 1-2.6-4.4V30.5l-9 2v13.2a5 5 0 1 1-2.6-4.4V30Z" fill="#fff" opacity=".95"/>`;
    s += txt(78, 36, fit(title, 14, 304, true), 14, { w: 800 });
    if (b.artist) s += txt(78, 54, fit(b.artist, 10.5, 304), 10.5, { fill: MUTED, w: 600 });
    bars.forEach((v, i) => { const h = Math.max(3, v * 72), on = (i + 0.5) / BARS <= p; s += rect(x0 + i * pitch, cy - h / 2, 4.2, h, on ? played : rest, { rx: 2.1 }); });
    if (p > 0) { const px = x0 + p * BARS * pitch - 1; s += rect(px - 0.8, 80, 1.6, 88, played) + circle(px, 80, 3.6, played); }
    s += txt(20, 178, total === undefined ? "" : clock(total * p), 9.5, { fill: FAINT, w: 700 }) + txt(380, 178, b.duration, 9.5, { fill: MUTED, w: 700, anchor: "end" });
    return tile({ label: badgeOf(b.name, "audio"), name: b.name, meta: [b.duration, b.size, b.modified], svg: s });
  },
  summary: b => `Audio ${b.name}, ${b.duration}${b.title ? `. ${b.title}` : ""}${b.artist ? ` by ${b.artist}` : ""}${b.size ? `, ${b.size}` : ""}.`,
  css: tileCss("audio_file", KINDS.audio.color),
});

export const ASSETS: readonly AnyAsset[] = [imageFile, videoFile, audioFile];

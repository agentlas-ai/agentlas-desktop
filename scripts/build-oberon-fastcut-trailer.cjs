#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const sourceDir =
  process.env.OBERON_TRAILER_SOURCE_DIR ||
  path.resolve(process.cwd(), "oberon-trailer-source");
const outBase = process.env.OBERON_TRAILER_OUT_BASE || path.join(sourceDir, "Oberon_Space_Blackhole_Trailer_20s_fastcut");
const workDir = path.join(sourceDir, "_fastcut_work");
const fontPath = process.env.OBERON_TRAILER_FONT || "/System/Library/Fonts/AppleSDGothicNeo.ttc";
const pythonBin =
  process.env.OBERON_TRAILER_PYTHON ||
  "python3";

const sources = {
  wake: "001_SH_001_DEEP_SPACE_WAKE_take1.mp4",
  war: "002_SH_002_ORBITAL_WAR_take1.mp4",
  blackhole: "003_SH_003_BLACKHOLE_APPROACH_take1.mp4",
  lost: "004_SH_004_LOST_EXPEDITION_take1.mp4",
  finale: "005_SH_005_EVENT_HORIZON_FINALE_take1.mp4",
};

const timeline = [
  { type: "video", source: "wake", start: 0.0, duration: 0.85 },
  { type: "card", text: "인류가 사라진 뒤", duration: 0.55 },
  { type: "video", source: "war", start: 0.2, duration: 0.9 },
  { type: "video", source: "blackhole", start: 0.15, duration: 0.8 },
  { type: "card", text: "전쟁은 별 사이에서 깨어났다", duration: 0.6 },
  { type: "video", source: "war", start: 1.45, duration: 1.05 },
  { type: "video", source: "lost", start: 0.25, duration: 0.85 },
  { type: "card", text: "귀환 신호 없음", duration: 0.5 },
  { type: "video", source: "wake", start: 1.1, duration: 0.95 },
  { type: "video", source: "blackhole", start: 1.2, duration: 1.1 },
  { type: "card", text: "그 너머에는", duration: 0.45 },
  { type: "video", source: "finale", start: 0.2, duration: 1.0 },
  { type: "video", source: "war", start: 2.75, duration: 0.8 },
  { type: "video", source: "lost", start: 1.35, duration: 1.0 },
  { type: "card", text: "블랙홀이 있었다", duration: 0.55 },
  { type: "video", source: "blackhole", start: 2.35, duration: 1.2 },
  { type: "video", source: "finale", start: 1.25, duration: 1.2 },
  { type: "card", text: "오베론", subtext: "EVENT HORIZON", duration: 0.7, title: true },
  { type: "video", source: "wake", start: 2.55, duration: 0.75 },
  { type: "video", source: "war", start: 0.95, duration: 0.65 },
  { type: "video", source: "blackhole", start: 0.85, duration: 0.85 },
  { type: "video", source: "lost", start: 2.6, duration: 0.75 },
  { type: "card", text: "사건의 지평선", duration: 0.65 },
  { type: "video", source: "finale", start: 2.35, duration: 1.3 },
];

async function run(bin, args) {
  await execFileAsync(bin, args, { maxBuffer: 1024 * 1024 * 16 });
}

function videoArgs(item, outPath) {
  return [
    "-y",
    "-ss",
    String(item.start),
    "-t",
    String(item.duration),
    "-i",
    path.join(sourceDir, sources[item.source]),
    "-vf",
    "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,fps=24,format=yuv420p",
    "-af",
    `aresample=48000,apad,atrim=0:${item.duration}`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outPath,
  ];
}

async function writeCardPng(item, index) {
  const specPath = path.join(workDir, `card_${String(index).padStart(2, "0")}.json`);
  const imagePath = path.join(workDir, `card_${String(index).padStart(2, "0")}.png`);
  await fs.writeFile(
    specPath,
    JSON.stringify({
      text: item.text,
      subtext: item.subtext || "",
      title: Boolean(item.title),
      fontPath,
      imagePath,
    }),
    "utf8",
  );
  const py = `
import json
from PIL import Image, ImageDraw, ImageFont, ImageFilter

spec = json.load(open(r"${specPath}", "r", encoding="utf-8"))
w, h = 1280, 720
img = Image.new("RGB", (w, h), (2, 3, 10))
px = img.load()
for y in range(h):
    t = y / max(1, h - 1)
    base = int(10 + 18 * (1 - abs(t - 0.5) * 2))
    for x in range(w):
        glow = int(22 * max(0, 1 - abs(x - w / 2) / (w / 2)) * max(0, 1 - abs(y - h * 0.6) / (h * 0.7)))
        px[x, y] = (2 + glow // 5, 3 + glow // 4, base + glow)
draw = ImageDraw.Draw(img)
font_size = 86 if spec["title"] else 56
try:
    title_font = ImageFont.truetype(spec["fontPath"], font_size)
    sub_font = ImageFont.truetype(spec["fontPath"], 28)
except Exception:
    title_font = ImageFont.load_default()
    sub_font = ImageFont.load_default()
text = spec["text"]
bbox = draw.textbbox((0, 0), text, font=title_font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
y = (h - th) / 2 - (30 if spec["subtext"] else 0)
for dx, dy in [(-2,0), (2,0), (0,-2), (0,2)]:
    draw.text(((w - tw) / 2 + dx, y + dy), text, font=title_font, fill=(9, 10, 24))
draw.text(((w - tw) / 2, y), text, font=title_font, fill=(245, 247, 255))
line_w = 440
line_y = int(h * 0.61)
draw.rounded_rectangle(((w - line_w) / 2, line_y, (w + line_w) / 2, line_y + 3), radius=2, fill=(90, 86, 220))
if spec["subtext"]:
    sub = spec["subtext"]
    sb = draw.textbbox((0, 0), sub, font=sub_font)
    sw, sh = sb[2] - sb[0], sb[3] - sb[1]
    draw.text(((w - sw) / 2, y + th + 42), sub, font=sub_font, fill=(158, 167, 255))
img.save(spec["imagePath"])
`;
  await run(pythonBin, ["-c", py]);
  return imagePath;
}

async function cardArgs(item, index, outPath) {
  const imagePath = await writeCardPng(item, index);
  return [
    "-y",
    "-loop",
    "1",
    "-framerate",
    "24",
    "-t",
    String(item.duration),
    "-i",
    imagePath,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-t",
    String(item.duration),
    "-vf",
    `fps=24,scale=1280:720,format=yuv420p,fade=t=in:st=0:d=0.08,fade=t=out:st=${Math.max(0, item.duration - 0.12)}:d=0.12`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "16",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outPath,
  ];
}

async function main() {
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });

  const segmentPaths = [];
  for (const [index, item] of timeline.entries()) {
    const outPath = path.join(workDir, `seg_${String(index + 1).padStart(2, "0")}.mp4`);
    if (item.type === "video") {
      await run("ffmpeg", videoArgs(item, outPath));
    } else {
      await run("ffmpeg", await cardArgs(item, index + 1, outPath));
    }
    segmentPaths.push(outPath);
  }

  const listPath = path.join(workDir, "concat.txt");
  await fs.writeFile(listPath, segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");

  const mp4 = `${outBase}.mp4`;
  const mov = `${outBase}.mov`;
  const wav = `${outBase}_audio.wav`;
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", mp4]);
  await run("ffmpeg", ["-y", "-i", mp4, "-c", "copy", mov]);
  await run("ffmpeg", ["-y", "-i", mp4, "-vn", "-acodec", "pcm_s16le", "-ar", "48000", "-ac", "2", wav]);

  const sum = timeline.reduce((total, item) => total + item.duration, 0);
  console.log(`FASTCUT_MP4=${mp4}`);
  console.log(`FASTCUT_MOV=${mov}`);
  console.log(`FASTCUT_WAV=${wav}`);
  console.log(`TIMELINE_SECONDS=${sum.toFixed(2)}`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});

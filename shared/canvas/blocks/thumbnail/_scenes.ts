import { loose } from "../../fields";
import { hash, nullable, r1, rng } from "./_shared";

/** The "photos" of the image and video thumbnails: six scenes drawn from gradients and shapes on the 400x195 stage (no <image>, nothing fetched). */
export const SCENES = ["sunset", "mountains", "ocean", "city", "forest", "abstract"] as const;
export type Scene = (typeof SCENES)[number];
export const sceneField = nullable(loose([...SCENES] as [Scene, ...Scene[]], {
  sunrise: "sunset", dusk: "sunset", evening: "sunset", sun: "sunset", mountain: "mountains", landscape: "mountains", alps: "mountains", hills: "mountains", snow: "mountains", sea: "ocean", beach: "ocean",
  water: "ocean", coast: "ocean", lake: "ocean", skyline: "city", night: "city", urban: "city", street: "city", buildings: "city", trees: "forest", woods: "forest", nature: "forest", jungle: "forest",
  gradient: "abstract", art: "abstract", blob: "abstract", shapes: "abstract",
}, "abstract").optional());
/** The scene a block names, or one picked from its name so a file without a scene still gets a picture of its own. */
export const sceneOf = (scene: string | undefined, name: string): Scene => (scene && (SCENES as readonly string[]).includes(scene) ? (scene as Scene) : SCENES[hash(name) % SCENES.length]);

const lin = (id: string, stops: [number, string][], x2 = 0, y2 = 1) => `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("")}</linearGradient>`;
const glow = (id: string, color: string, a: number) => `<radialGradient id="${id}"><stop offset="0" stop-color="${color}" stop-opacity="${a}"/><stop offset=".4" stop-color="${color}" stop-opacity="${a * 0.5}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`;
const FULL = `width="400" height="195"`;

/** A pine: three stacked tiers, `h` tall, centred on `x`, standing on `base`. */
function pine(x: number, base: number, h: number): string {
  const w = h * 0.5, y1 = base - h * 0.62, y2 = base - h * 0.32;
  return `M${r1(x)} ${r1(base - h)}L${r1(x + w * 0.3)} ${r1(y1)}H${r1(x + w * 0.18)}L${r1(x + w * 0.42)} ${r1(y2)}H${r1(x + w * 0.26)}L${r1(x + w * 0.5)} ${r1(base)}H${r1(x - w * 0.5)}L${r1(x - w * 0.26)} ${r1(y2)}H${r1(x - w * 0.42)}L${r1(x - w * 0.18)} ${r1(y1)}H${r1(x - w * 0.3)}Z`;
}
const pines = (rand: () => number, from: number, to: number, pitch: number, base: number, hMin: number, hMax: number, fill: string, op = 1) => {
  let d = ""; for (let x = from; x <= to; x += pitch * (0.8 + rand() * 0.45)) d += pine(x, base, hMin + rand() * (hMax - hMin));
  return `<path d="${d}" fill="${fill}"${op < 1 ? ` opacity="${op}"` : ""}/>`;
};

function sunset(u: string): string {
  return `<defs>${lin(`${u}-sk`, [[0, "#2e1a5e"], [0.42, "#b8397a"], [0.74, "#f58a3e"], [1, "#ffd27a"]])}${glow(`${u}-sn`, "#ffd27a", 0.9)}</defs><rect ${FULL} fill="url(#${u}-sk)"/>`
    + `<ellipse cx="96" cy="84" rx="66" ry="3.4" fill="#ffd9a8" opacity=".3"/><ellipse cx="318" cy="62" rx="52" ry="3" fill="#ffc7a0" opacity=".3"/><ellipse cx="150" cy="112" rx="44" ry="2.6" fill="#ffe3b0" opacity=".28"/>`
    + `<circle cx="268" cy="128" r="92" fill="url(#${u}-sn)"/><circle cx="268" cy="128" r="26" fill="#fff6d2"/>`
    + `<path d="M92 36q4-5 8 0q4-5 8 0M122 50q3-4 6 0q3-4 6 0" fill="none" stroke="#2e1a5e" stroke-width="1.4" stroke-linecap="round" opacity=".6"/>`
    + `<path d="M0 148C50 132 110 142 180 148S320 136 400 146V195H0Z" fill="#7a2f6a" opacity=".92"/><path d="M0 166C70 150 150 170 230 160S350 154 400 164V195H0Z" fill="#35164f"/><path d="M0 183C90 173 180 189 280 179S370 177 400 183V195H0Z" fill="#1d0c33"/>`;
}
function mountains(u: string): string {
  return `<defs>${lin(`${u}-sk`, [[0, "#3f7fee"], [0.62, "#bfe0ff"], [1, "#eef7ff"]])}${lin(`${u}-lk`, [[0, "#7cbbe0"], [1, "#2f7fb0"]])}</defs><rect ${FULL} fill="url(#${u}-sk)"/>`
    + `<circle cx="318" cy="42" r="30" fill="#fff" opacity=".25"/><circle cx="318" cy="42" r="13" fill="#fff" opacity=".92"/>`
    + `<ellipse cx="120" cy="40" rx="36" ry="5" fill="#fff" opacity=".7"/><ellipse cx="146" cy="34" rx="22" ry="4.5" fill="#fff" opacity=".75"/>`
    + `<path d="M0 128L48 92L86 116L140 70L196 122L244 88L304 124L352 84L400 118V195H0Z" fill="#a3bbe6"/>`
    + `<path d="M0 152L64 98L112 138L184 76L254 148L312 106L366 142L400 122V195H0Z" fill="#5879b8"/>`
    + `<path d="M184 76L166 104L176 100L184 111L193 99L203 106Z" fill="#fff" opacity=".94"/><path d="M64 98L50 118L58 115L65 124L73 114L80 119Z" fill="#fff" opacity=".9"/><path d="M312 106L300 122L307 119L313 127L319 119L325 123Z" fill="#fff" opacity=".85"/>`
    + `<path d="M0 166C60 150 120 160 190 168S330 150 400 164V195H0Z" fill="url(#${u}-lk)"/><path d="M0 180C70 170 150 188 250 178S360 174 400 180V195H0Z" fill="#256b53"/>`
    + `<path d="${pine(24, 186, 34)}${pine(46, 190, 26)}${pine(364, 188, 36)}${pine(386, 191, 28)}" fill="#17493b"/>`;
}
function ocean(u: string): string {
  let waves = ""; [[0, 124], [14, 143], [-9, 163], [8, 183]].forEach(([dx, y], i) => { waves += `<path d="M${dx - 20} ${y}q25-7 50 0t50 0t50 0t50 0t50 0t50 0t50 0t50 0t50 0" fill="none" stroke="#fff" stroke-width="${1.6 - i * 0.2}" opacity="${0.3 - i * 0.04}" stroke-linecap="round"/>`; });
  return `<defs>${lin(`${u}-sk`, [[0, "#3c88f5"], [0.65, "#c2e8ff"], [1, "#fff0d4"]])}${lin(`${u}-sea`, [[0, "#2b93e6"], [1, "#093a78"]])}${glow(`${u}-sn`, "#fff1c0", 0.9)}</defs><rect ${FULL} fill="url(#${u}-sk)"/>`
    + `<circle cx="256" cy="96" r="52" fill="url(#${u}-sn)"/><circle cx="256" cy="96" r="16" fill="#fff6d0"/>`
    + `<ellipse cx="90" cy="38" rx="42" ry="5" fill="#fff" opacity=".7"/><ellipse cx="120" cy="30" rx="24" ry="4.5" fill="#fff" opacity=".7"/>`
    + `<rect y="100" ${FULL.replace('height="195"', 'height="95"')} fill="url(#${u}-sea)"/>${waves}`
    + `<ellipse cx="256" cy="106" rx="30" ry="1.8" fill="#fff4c8" opacity=".8"/><ellipse cx="256" cy="113" rx="22" ry="1.6" fill="#fff4c8" opacity=".6"/><ellipse cx="256" cy="121" rx="14" ry="1.4" fill="#fff4c8" opacity=".5"/><ellipse cx="256" cy="130" rx="8" ry="1.2" fill="#fff4c8" opacity=".4"/>`
    + `<path d="M80 101h38l-7 8H88z" fill="#fff"/><path d="M99 99V64L120 97Z" fill="#fff"/><path d="M96 99V72L82 97Z" fill="#ffe3bd"/>`;
}
function city(u: string): string {
  const rand = rng(11); let stars = "", back = "", front = "", wins = "";
  for (let i = 0; i < 26; i++) stars += `<circle cx="${r1(rand() * 400)}" cy="${r1(rand() * 82)}" r="${r1(0.5 + rand() * 0.8)}" fill="#fff" opacity="${r1(0.4 + rand() * 0.5)}"/>`;
  for (let x = -6; x < 410;) { const w = 22 + rand() * 24, h = 46 + rand() * 62; back += `<rect x="${r1(x)}" y="${r1(168 - h)}" width="${r1(w)}" height="${r1(h + 30)}" fill="#2a3282"/>`; x += w + 1.5; }
  for (let x = -4; x < 410;) {
    const w = 20 + rand() * 26, h = 30 + rand() * 72, top = 190 - h; front += `<rect x="${r1(x)}" y="${r1(top)}" width="${r1(w)}" height="${r1(h + 10)}" fill="#0c1233"/>`;
    for (let wy = top + 7; wy < 186; wy += 8) for (let wx = x + 4; wx < x + w - 5; wx += 6.4) if (rand() < 0.34) wins += `<rect x="${r1(wx)}" y="${r1(wy)}" width="2.8" height="3.6" fill="#ffd27a" opacity="${r1(0.55 + rand() * 0.45)}"/>`;
    x += w + 2;
  }
  return `<defs>${lin(`${u}-sk`, [[0, "#0b1640"], [0.55, "#3a3a96"], [1, "#f08090"]])}${glow(`${u}-mn`, "#fff6dc", 0.7)}</defs><rect ${FULL} fill="url(#${u}-sk)"/>${stars}`
    + `<circle cx="322" cy="40" r="34" fill="url(#${u}-mn)"/><circle cx="322" cy="40" r="13" fill="#fff6dc"/>`
    + `<g opacity=".85">${back}</g><g>${front}</g>${wins}`;
}
function forest(u: string): string {
  const rand = rng(5);
  return `<defs>${lin(`${u}-sk`, [[0, "#f7fad8"], [1, "#c9e8bd"]])}${glow(`${u}-sn`, "#fffbd0", 0.95)}</defs><rect ${FULL} fill="url(#${u}-sk)"/>`
    + `<circle cx="318" cy="30" r="80" fill="url(#${u}-sn)"/>`
    + pines(rand, 0, 410, 20, 124, 46, 70, "#9ad3a4") + `<rect y="96" ${FULL.replace('height="195"', 'height="40"')} fill="#fff" opacity=".28"/>`
    + pines(rand, -6, 410, 26, 152, 66, 92, "#46b078") + `<rect y="126" ${FULL.replace('height="195"', 'height="36"')} fill="#fff" opacity=".18"/>`
    + pines(rand, 4, 410, 34, 196, 92, 128, "#0e6e49") + pines(rand, -10, 420, 62, 200, 120, 160, "#07432f")
    + `<path d="M0 188C100 178 220 192 400 182V195H0Z" fill="#05341f"/>`;
}
function abstract(u: string): string {
  return `<defs>${lin(`${u}-bg`, [[0, "#f6a02c"], [0.5, "#d6336c"], [1, "#5b3bd0"]], 1, 1)}${lin(`${u}-b2`, [[0, "#2f5fd6"], [1, "#7aa2ff"]], 1, 1)}</defs><rect ${FULL} fill="url(#${u}-bg)"/>`
    + `<circle cx="96" cy="62" r="66" fill="#ffd27a" opacity=".55"/><circle cx="318" cy="134" r="90" fill="url(#${u}-b2)" opacity=".62"/><circle cx="238" cy="38" r="26" fill="#fff" opacity=".26"/>`
    + `<circle cx="318" cy="134" r="60" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="1.3"/><circle cx="318" cy="134" r="36" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.3"/>`
    + `<path d="M0 152C60 122 120 182 200 152S340 122 400 152V195H0Z" fill="#fff" opacity=".15"/><path d="M0 172C70 150 150 190 230 168S350 150 400 170V195H0Z" fill="#101d24" opacity=".22"/>`
    + `<circle cx="64" cy="150" r="14" fill="#fff" opacity=".3"/><circle cx="148" cy="112" r="6" fill="#fff" opacity=".5"/>`;
}

const DRAW: Record<Scene, (u: string) => string> = { sunset, mountains, ocean, city, forest, abstract };
/** A scene as SVG for the 400x195 stage; `u` prefixes its gradient ids. */
export const scenePicture = (scene: Scene, u: string): string => DRAW[scene](u);

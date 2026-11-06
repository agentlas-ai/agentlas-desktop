import { loose } from "../../fields";

/** The illustrations of image_caption_slide: every one is drawn from shapes and gradients (no picture, no font, no address), in an 80 x 100 box that is sliced to its panel. */
export const SCENES = ["sunset", "mountains", "ocean", "city", "forest", "abstract"] as const;
export const scene = loose([...SCENES] as [string, ...string[]], { sunrise: "sunset", dusk: "sunset", sun: "sunset", sky: "sunset", mountain: "mountains", hills: "mountains", alps: "mountains", peaks: "mountains", sea: "ocean", water: "ocean", beach: "ocean", coast: "ocean", waves: "ocean", urban: "city", skyline: "city", town: "city", night: "city", forests: "forest", trees: "forest", woods: "forest", nature: "forest", geometric: "abstract", shapes: "abstract", art: "abstract" }, "abstract");

/** A repeatable pseudo-random number in [0, 1) for a seed (the same picture every time). */
const rnd = (i: number) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const lg = (id: string, stops: [number, string][], x2 = 0, y2 = 1) => `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("")}</linearGradient>`;
/** A row of pines standing on `base`: height `h`, spacing `step`, a seed for the jitter; the ground below them is filled too. */
const pines = (fill: string, base: number, h: number, step: number, seed: number) => {
  let d = `M0,${base}H80V100H0z`;
  for (let x = -2, i = 0; x < 84; x += step, i++) {
    const hh = h * (0.7 + rnd(i + seed) * 0.6), w = hh * 0.38, c = x + step / 2;
    const pts: [number, number][] = [[c, base - hh], [c + 0.5 * w, base - 0.68 * hh], [c + 0.26 * w, base - 0.68 * hh], [c + 0.78 * w, base - 0.36 * hh], [c + 0.38 * w, base - 0.36 * hh], [c + w, base], [c - w, base], [c - 0.38 * w, base - 0.36 * hh], [c - 0.78 * w, base - 0.36 * hh], [c - 0.26 * w, base - 0.68 * hh], [c - 0.5 * w, base - 0.68 * hh]];
    d += `M${pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join("L")}z`;
  }
  return `<path d="${d}" fill="${fill}"/>`;
};

const ART: Record<string, (u: string) => string> = {
  sunset: u => `<defs>${lg(`${u}a`, [[0, "#2e1a6e"], [0.42, "#c2306f"], [0.7, "#f08a24"], [1, "#ffd27a"]])}<radialGradient id="${u}b"><stop offset="0" stop-color="#fff6d6"/><stop offset="1" stop-color="#ffd27a"/></radialGradient><radialGradient id="${u}c"><stop offset="0" stop-color="#fff" stop-opacity=".5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>${lg(`${u}d`, [[0, "#6b2a6e"], [1, "#1f1247"]])}</defs>
<rect width="80" height="100" fill="url(#${u}a)"/>${Array.from({ length: 16 }, (_, i) => `<circle cx="${(rnd(i + 3) * 80).toFixed(1)}" cy="${(rnd(i + 40) * 34).toFixed(1)}" r="${(0.2 + rnd(i) * 0.5).toFixed(2)}" fill="#fff" opacity="${(0.3 + rnd(i + 9) * 0.5).toFixed(2)}"/>`).join("")}
<circle cx="40" cy="62" r="34" fill="url(#${u}c)"/><circle cx="40" cy="62" r="15" fill="url(#${u}b)"/>
<rect y="62" width="80" height="38" fill="url(#${u}d)"/>${[0, 1, 2, 3, 4, 5].map(i => `<rect x="${(40 - (13 - i * 2)).toFixed(1)}" y="${(64 + i * 4.6).toFixed(1)}" width="${(26 - i * 4).toFixed(1)}" height="1.3" rx=".65" fill="#ffd27a" opacity="${(0.75 - i * 0.1).toFixed(2)}"/>`).join("")}
<path d="M0,62C8,55 16,57 24,62zM56,62C64,58 72,57 80,61V62z" fill="#2a1558"/><path d="M52,24q2,-2.4 4,0M60,30q1.6,-2 3.2,0" fill="none" stroke="#2a1558" stroke-width=".7" stroke-linecap="round"/>`,
  mountains: u => `<defs>${lg(`${u}a`, [[0, "#bcd4ff"], [0.6, "#ffe6cf"], [1, "#fff4e6"]])}<linearGradient id="${u}m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".75"/></linearGradient></defs>
<rect width="80" height="100" fill="url(#${u}a)"/><circle cx="58" cy="30" r="8" fill="#fff7e0"/><circle cx="58" cy="30" r="13" fill="#fff" opacity=".35"/>
<path d="M0,66L14,44L24,58L38,34L52,62L64,46L80,64V100H0z" fill="#9db4e6"/><path d="M38,34L33,43L38,40L42,45z" fill="#fff"/><path d="M14,44L10,51L14,49L17,53z" fill="#fff"/>
<rect y="56" width="80" height="22" fill="url(#${u}m)"/>
<path d="M0,80L16,54L28,74L44,48L60,76L80,58V100H0z" fill="#4a6fb8"/><path d="M44,48L38,59L44,56L48,62z" fill="#fff"/><path d="M16,54L11,63L16,60L19,66z" fill="#fff" opacity=".9"/>
<rect y="70" width="80" height="18" fill="url(#${u}m)"/>
<path d="M0,100V82L18,74L34,86L52,76L80,88V100z" fill="#1c3f9c"/>${pines("#0b3a2f", 96, 17, 6.5, 5)}`,
  ocean: u => `<defs>${lg(`${u}a`, [[0, "#6f9bff"], [1, "#e3f1ff"]])}${lg(`${u}b`, [[0, "#2f5fd6"], [1, "#0a2468"]])}<radialGradient id="${u}c"><stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
<rect width="80" height="100" fill="url(#${u}a)"/><circle cx="58" cy="36" r="22" fill="url(#${u}c)"/><circle cx="58" cy="36" r="7" fill="#fff"/>
<ellipse cx="18" cy="22" rx="12" ry="3" fill="#fff" opacity=".85"/><ellipse cx="25" cy="19.5" rx="8" ry="3" fill="#fff" opacity=".85"/><ellipse cx="66" cy="14" rx="9" ry="2.2" fill="#fff" opacity=".7"/>
<rect y="54" width="80" height="46" fill="url(#${u}b)"/>${[0, 1, 2, 3, 4, 5].map(i => `<path d="M0,${(60 + i * 7).toFixed(1)}q10,-3 20,0t20,0t20,0t20,0" fill="none" stroke="#fff" stroke-opacity="${(0.1 + i * 0.06).toFixed(2)}" stroke-width="${(0.5 + i * 0.12).toFixed(2)}" transform="translate(${i % 2 ? -8 : 0},0)"/>`).join("")}
<path d="M52,54h12v1.3H52z" fill="#fff" opacity=".7"/><path d="M26,66h14l-2.4,3.6H28.4z" fill="#fff"/><path d="M33,64V50L42,63.5z" fill="#fff"/><path d="M31.6,64.4V53L25,64.4z" fill="#ffd27a"/>`,
  city: u => {
    let far = "", near = "", win = "";
    for (let i = 0, x = -2; x < 80; i++) { const w = 7 + rnd(i + 2) * 8, h = 28 + rnd(i + 20) * 34; far += `<rect x="${x.toFixed(1)}" y="${(86 - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#3a2a78"/>`; x += w + 0.8; }
    for (let i = 0, x = -3; x < 80; i++) {
      const w = 8 + rnd(i + 7) * 9, h = 18 + rnd(i + 31) * 42, top = 100 - h; near += `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#0f1726"/>`;
      for (let wy = top + 3, r = 0; wy < 96; wy += 4.2, r++) for (let wx = x + 1.6, c = 0; wx < x + w - 2; wx += 3.2, c++) if (rnd(i * 53 + r * 7 + c * 3) > 0.55) win += `<rect x="${wx.toFixed(1)}" y="${wy.toFixed(1)}" width="1.6" height="2" fill="#ffd27a" opacity="${(0.55 + rnd(r + c + i) * 0.45).toFixed(2)}"/>`;
      x += w + 1.2;
    }
    return `<defs>${lg(`${u}a`, [[0, "#0f1b3c"], [0.55, "#4c1d95"], [1, "#e0457b"]])}</defs><rect width="80" height="100" fill="url(#${u}a)"/>${Array.from({ length: 22 }, (_, i) => `<circle cx="${(rnd(i + 3) * 80).toFixed(1)}" cy="${(rnd(i + 70) * 44).toFixed(1)}" r="${(0.2 + rnd(i) * 0.4).toFixed(2)}" fill="#fff" opacity="${(0.35 + rnd(i + 9) * 0.5).toFixed(2)}"/>`).join("")}<circle cx="60" cy="22" r="6.5" fill="#fff6d6"/><circle cx="62.6" cy="20.4" r="5.6" fill="#3a2a78" opacity=".18"/><rect y="84" width="80" height="16" fill="#0f1726"/>${far}${near}${win}`;
  },
  forest: u => `<defs>${lg(`${u}a`, [[0, "#eaf8f1"], [1, "#a9dfc4"]])}<linearGradient id="${u}m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#e9f7ef" stop-opacity=".85"/></linearGradient><linearGradient id="${u}r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
<rect width="80" height="100" fill="url(#${u}a)"/><path d="M50,0L72,0L30,100L4,100z" fill="url(#${u}r)" opacity=".6"/><circle cx="62" cy="14" r="7" fill="#fffbe6"/>
${pines("#7cc6a4", 78, 26, 8, 11)}<rect y="46" width="80" height="34" fill="url(#${u}m)"/>${pines("#2c9a6e", 90, 30, 9.5, 23)}<rect y="62" width="80" height="30" fill="url(#${u}m)"/>${pines("#0b4f3c", 97, 36, 12, 37)}`,
  abstract: u => `<defs>${lg(`${u}a`, [[0, "#2f5fd6"], [0.6, "#7c3aed"], [1, "#d6336c"]], 1, 1)}<radialGradient id="${u}b"><stop offset="0" stop-color="#fff6d6"/><stop offset="1" stop-color="#ffd27a"/></radialGradient></defs>
<rect width="80" height="100" fill="url(#${u}a)"/><circle cx="56" cy="30" r="20" fill="#fff" opacity=".14"/><circle cx="56" cy="30" r="12" fill="url(#${u}b)"/><circle cx="20" cy="78" r="26" fill="#fff" opacity=".1"/><circle cx="20" cy="78" r="15" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width=".8"/>
<path d="M0,56C20,40 40,70 80,48V62C40,84 20,54 0,70z" fill="#fff" opacity=".18"/><path d="M0,70C22,56 44,86 80,64V74C44,98 22,70 0,82z" fill="#0b1a3c" opacity=".22"/>${Array.from({ length: 20 }, (_, i) => `<circle cx="${8 + (i % 5) * 4}" cy="${10 + Math.floor(i / 5) * 4}" r=".7" fill="#fff" opacity=".55"/>`).join("")}<rect x="46" y="68" width="22" height="22" rx="5" fill="none" stroke="#ffd27a" stroke-opacity=".8" stroke-width=".9" transform="rotate(14 57 79)"/>`,
};
/** The illustration for a scene word, filling its panel (the panel is positioned by the slide). */
export const sceneSvg = (name: string, uid: string) => `<svg class="a-art" style="position:absolute;inset:0;width:100%;height:100%" viewBox="0 0 80 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${(ART[name] ?? ART.abstract)(`${uid}s`)}</svg>`;

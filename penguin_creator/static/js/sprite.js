// Procedural pixel-art penguins.
import { speciesKey as shortSpecies } from "./csv.js";
//
// Every visible feature is driven by a column of the Palmer penguins dataset:
//   Species              -> plumage pattern, bill and feet colour
//   Body Mass (g)        -> body width / roundness
//   Flipper Length (mm)  -> flipper length and (a little) height
//   Culmen Length (mm)   -> bill length
//   Culmen Depth (mm)    -> bill thickness
//   Sex                  -> badge in the portrait frame
//   Island               -> background scene
//   Clutch Completion    -> eggs in the nest (Yes = 2, No = 1)
//   Delta 15 N           -> what the penguin is eating (krill <-> fish)
//   Delta 13 C           -> water colour (offshore blue <-> inshore green)

const OUTLINE = "#1a1220";

const PALETTE = {
  back: "#283044",
  backLight: "#3b4663",
  belly: "#f7f3e8",
  bellyShade: "#dcd6c8",
  eye: "#0d0a12",
  eyeShine: "#ffffff",
  blush: "#f2a3a3",
};

const SPECIES_STYLE = {
  Adelie: { bill: "#2a2730", billTip: "#3d3944", feet: "#e8a6a0", feetDark: "#c98582" },
  Chinstrap: { bill: "#2a2730", billTip: "#3d3944", feet: "#eaa3ad", feetDark: "#c98590" },
  Gentoo: { bill: "#ee6a2a", billTip: "#2a2730", feet: "#f39a35", feetDark: "#d07a1c" },
};

// Species names come from csv.js; shortSpecies() here returns null for anything
// that isn't one of the three Palmer species.
export { SPECIES as SPECIES_FULL, speciesKey as shortSpecies } from "./csv.js";

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const norm = (v, lo, hi) => clamp01((v - lo) / (hi - lo));

// Default values when a measurement is missing (roughly the dataset mean).
const DEFAULTS = {
  "Culmen Length (mm)": 44,
  "Culmen Depth (mm)": 17,
  "Flipper Length (mm)": 200,
  "Body Mass (g)": 4200,
  "Delta 15 N (o/oo)": 8.7,
  "Delta 13 C (o/oo)": -25.7,
};

function num(record, col, fallbacks) {
  const v = parseFloat(record[col]);
  if (Number.isFinite(v)) return v;
  if (fallbacks && Number.isFinite(fallbacks[col])) return fallbacks[col];
  return DEFAULTS[col];
}

// --- a tiny pixel buffer ------------------------------------------------

class Pixels {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Array(w * h).fill(null);
  }
  set(x, y, c) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.px[y * this.w + x] = c;
  }
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    return this.px[y * this.w + x];
  }
  ellipse(cx, cy, rx, ry, c, test) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / (rx + 0.35);
        const dy = (y - cy) / (ry + 0.35);
        if (dx * dx + dy * dy <= 1 && (!test || test(x, y))) this.set(x, y, c);
      }
    }
  }
  rect(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }
  polygon(points, c) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
      for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
        if (inside(x + 0.5, y + 0.5, points)) this.set(x, y, c);
      }
    }
  }
  line(x0, y0, x1, y1, c) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= steps; i++) this.set(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, c);
  }
  outline(color) {
    const add = [];
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        if (this.get(x, y)) continue;
        if (this.get(x + 1, y) || this.get(x - 1, y) || this.get(x, y + 1) || this.get(x, y - 1)) add.push([x, y]);
      }
    for (const [x, y] of add) this.set(x, y, color);
  }
  drawTo(ctx, ox = 0, oy = 0) {
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        const c = this.px[y * this.w + x];
        if (c) {
          ctx.fillStyle = c;
          ctx.fillRect(ox + x, oy + y, 1, 1);
        }
      }
  }
}

function inside(x, y, pts) {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// --- the penguin ---------------------------------------------------------

export const SPRITE_SIZE = 64;

/**
 * Build the 64x64 pixel sprite of a penguin record.
 * opts.blink: draw closed eyes. opts.fallbacks: per-measure values to use when missing.
 */
export function penguinPixels(record, opts = {}) {
  const species = shortSpecies(record.Species) || "Adelie";
  const style = SPECIES_STYLE[species];
  const f = opts.fallbacks;
  const mass = num(record, "Body Mass (g)", f);
  const flipper = num(record, "Flipper Length (mm)", f);
  const cLen = num(record, "Culmen Length (mm)", f);
  const cDep = num(record, "Culmen Depth (mm)", f);

  const nm = norm(mass, 2600, 6400);
  const nf = norm(flipper, 170, 235);
  const nl = norm(cLen, 32, 60);
  const nd = norm(cDep, 13, 22);

  const p = new Pixels(SPRITE_SIZE, SPRITE_SIZE);
  const footY = 59;
  const bodyRx = 8.5 + 9 * nm;
  const bodyRy = 13 + 5 * nf + 2.5 * nm;
  const cx = 30;
  const cy = footY - 2 - bodyRy;

  // tail
  p.polygon([[cx - bodyRx * 0.6, footY - 5], [cx - bodyRx - 3, footY], [cx - bodyRx * 0.2, footY - 2]], PALETTE.back);

  // body (dark back) + belly
  p.ellipse(cx, cy, bodyRx, bodyRy, PALETTE.back);
  p.ellipse(cx - bodyRx * 0.45, cy - bodyRy * 0.2, bodyRx * 0.35, bodyRy * 0.6, PALETTE.backLight, (x, y) => p.get(x, y) === PALETTE.back);
  p.ellipse(cx + bodyRx * 0.28, cy + 2, bodyRx * 0.68, bodyRy - 2.5, PALETTE.belly);
  p.ellipse(cx + bodyRx * 0.28 - 1, cy + bodyRy * 0.55, bodyRx * 0.55, bodyRy * 0.25, PALETTE.bellyShade, (x, y) => p.get(x, y) === PALETTE.belly && y > cy + bodyRy * 0.5);

  // head
  const hr = 6.5 + 1.2 * nm;
  const hx = cx + bodyRx * 0.25 + 1;
  const hy = cy - bodyRy + hr * 0.55;
  p.ellipse(hx, hy, hr + 0.5, hr, PALETTE.back);

  // face pattern
  const eyeX = Math.round(hx + hr * 0.45);
  const eyeY = Math.round(hy - 1);
  if (species === "Chinstrap") {
    // white face below the cap, thin black strap under the chin
    p.ellipse(hx + 1, hy + 2, hr - 0.5, hr - 1.5, PALETTE.belly, (x, y) => y >= hy - 2);
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const x = hx - hr + 2 + t * (hr * 1.7);
      const y = hy + 1 + Math.sin(t * Math.PI) * 4.5 - t * 1.5;
      p.set(x, y, PALETTE.back);
    }
    p.set(eyeX + 1, eyeY + 2, PALETTE.blush);
  } else if (species === "Gentoo") {
    // white bonnet stripe over the crown from eye to eye
    p.ellipse(eyeX - 1, eyeY - 2, 2.6, 1.6, PALETTE.belly);
    p.line(eyeX - 2, eyeY - 3, hx - 2, hy - hr + 1, PALETTE.belly);
    p.line(eyeX - 1, eyeY - 3, hx - 1, hy - hr + 1, PALETTE.belly);
  } else {
    // Adelie: plain black head, bold white eye ring
    p.ellipse(eyeX, eyeY, 1.6, 1.6, PALETTE.belly);
  }

  // eye
  if (opts.blink) {
    p.set(eyeX - 1, eyeY, PALETTE.eye);
    p.set(eyeX, eyeY, PALETTE.eye);
  } else {
    p.set(eyeX, eyeY, PALETTE.eye);
    p.set(eyeX, eyeY - 1, species === "Adelie" ? PALETTE.eye : PALETTE.eyeShine);
    if (species !== "Adelie") p.set(eyeX - 1, eyeY, PALETTE.eye);
  }

  // bill: length from culmen length, thickness from culmen depth
  const billLen = Math.round(3 + 9 * nl);
  const billDepth = 1.6 + 3.2 * nd;
  const bx = hx + hr - 0.5;
  const by = hy + 1.5;
  p.polygon(
    [
      [bx - 1, by - billDepth / 2],
      [bx + billLen, by + 0.2],
      [bx + billLen - 0.5, by + 1],
      [bx - 1, by + billDepth / 2 + 0.6],
    ],
    style.bill,
  );
  p.set(bx + billLen - 1, by, style.billTip);
  if (billDepth > 2.6) p.line(bx, by + 0.4, bx + billLen - 2, by + 0.4, shade(style.bill));

  // flipper: length from flipper length
  const fl = 8 + 13 * nf;
  const sx = cx - bodyRx * 0.25;
  const sy = cy - bodyRy * 0.45;
  const tipX = sx - 4 - 3 * nf;
  const tipY = sy + fl;
  p.polygon([[sx - 1.5, sy], [sx + 2.5, sy + 1], [tipX + 1.5, tipY], [tipX - 0.5, tipY - 1.5]], PALETTE.back);
  p.line(sx + 1.5, sy + 2, tipX + 1, tipY - 1, PALETTE.backLight);

  // feet
  p.ellipse(cx - 2, footY, 3, 1, style.feet);
  p.ellipse(cx + bodyRx * 0.55 + 2, footY, 3, 1, style.feet);
  p.set(cx + bodyRx * 0.55 + 4, footY, style.feetDark);
  p.set(cx, footY, style.feetDark);

  p.outline(OUTLINE);
  return p;
}

function shade(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, ((n >> 16) & 255) - 40);
  const g = Math.max(0, ((n >> 8) & 255) - 40);
  const b = Math.max(0, (n & 255) - 40);
  return `rgb(${r},${g},${b})`;
}

/** Draw only the penguin (transparent background) on a canvas, e.g. ledger thumbnails. */
export function drawThumbnail(canvas, record, opts = {}) {
  canvas.width = SPRITE_SIZE;
  canvas.height = SPRITE_SIZE;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  penguinPixels(record, opts).drawTo(ctx);
}

// --- the portrait scene ---------------------------------------------------

export const SCENE_W = 112;
export const SCENE_H = 84;

const ISLAND_SCENES = {
  Biscoe: { sky: ["#8fd3ff", "#a9ddff", "#c4e8ff", "#dff3ff"], far: "#eef8ff", farShade: "#c3dcef", ground: "#f4f8fb", groundShade: "#cfdde8", label: "Biscoe" },
  Dream: { sky: ["#3b2f6b", "#5a3f86", "#8d5aa0", "#e09ab0"], far: "#b8a6d6", farShade: "#8e7cb5", ground: "#9a8fa8", groundShade: "#7c718c", label: "Dream", aurora: true },
  Torgersen: { sky: ["#9aa6b5", "#adb8c5", "#c0c9d3", "#d3dae2"], far: "#7d8794", farShade: "#646d79", ground: "#6f6a66", groundShade: "#57524f", label: "Torgersen", rocks: true },
  _: { sky: ["#b9c7d6", "#c9d5e1", "#d9e2eb", "#e9eff5"], far: "#d6dee6", farShade: "#b7c2cd", ground: "#e4e9ee", groundShade: "#c5ced6", label: "?" },
};

function lerpColor(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

function seaColor(d13c) {
  // more negative d13C = offshore/pelagic (deep blue); less negative = inshore (teal)
  const t = norm(d13c, -27, -23.5);
  return [lerpColor("#1d4f8f", "#2f8f86", t), lerpColor("#2a64a8", "#46a89b", t)];
}

/**
 * Draw the full portrait: island backdrop, sea, nest with eggs, food and the penguin.
 * `frame` animates idle bobbing and the occasional blink.
 */
export function drawScene(canvas, record, opts = {}) {
  const frame = opts.frame || 0;
  canvas.width = SCENE_W;
  canvas.height = SCENE_H;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const scene = ISLAND_SCENES[record.Island] || ISLAND_SCENES._;

  // sky in hard bands (pixel-art style gradient)
  const bands = scene.sky;
  const skyH = 44;
  for (let i = 0; i < bands.length; i++) {
    ctx.fillStyle = bands[i];
    ctx.fillRect(0, Math.floor((i * skyH) / bands.length), SCENE_W, Math.ceil(skyH / bands.length) + 1);
  }
  if (scene.aurora) {
    for (let x = 0; x < SCENE_W; x++) {
      const y = 8 + Math.round(3 * Math.sin((x + frame * 0.5) / 9));
      ctx.fillStyle = "rgba(120,255,190,0.45)";
      ctx.fillRect(x, y, 1, 3 + ((x >> 3) % 2));
    }
    ctx.fillStyle = "#fff6d8";
    for (const [sx, sy] of [[10, 4], [33, 12], [58, 3], [80, 9], [100, 5], [91, 16]]) ctx.fillRect(sx, sy, 1, 1);
  } else {
    // drifting clouds
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    const off = Math.floor(frame / 6) % (SCENE_W + 30);
    for (const [cx0, cy] of [[10, 8], [70, 14]]) {
      const cx = ((cx0 + off) % (SCENE_W + 30)) - 15;
      ctx.fillRect(cx, cy, 14, 3);
      ctx.fillRect(cx + 3, cy - 2, 7, 2);
    }
  }

  // distant ice / hills
  ctx.fillStyle = scene.far;
  for (let x = 0; x < SCENE_W; x++) {
    const h = 6 + Math.round(5 * Math.sin(x / 11) + 3 * Math.sin(x / 4.3 + 1));
    ctx.fillRect(x, 40 - h, 1, h);
  }
  ctx.fillStyle = scene.farShade;
  for (let x = 0; x < SCENE_W; x++) {
    const h = 6 + Math.round(5 * Math.sin(x / 11) + 3 * Math.sin(x / 4.3 + 1));
    if (Math.sin(x / 11) < 0) ctx.fillRect(x, 40 - Math.floor(h / 2), 1, Math.floor(h / 2));
  }

  // sea, coloured by foraging habitat (Delta 13 C)
  const [sea, seaLight] = seaColor(num(record, "Delta 13 C (o/oo)"));
  ctx.fillStyle = sea;
  ctx.fillRect(0, 40, SCENE_W, 12);
  ctx.fillStyle = seaLight;
  for (let x = (frame >> 2) % 8; x < SCENE_W; x += 8) ctx.fillRect(x, 43 + ((x >> 3) % 3) * 3, 4, 1);

  // ground
  ctx.fillStyle = scene.ground;
  ctx.fillRect(0, 52, SCENE_W, SCENE_H - 52);
  ctx.fillStyle = scene.groundShade;
  for (let x = 0; x < SCENE_W; x++) if ((x * 7) % 13 < 3) ctx.fillRect(x, 52, 1, 1);
  ctx.fillRect(0, 52, SCENE_W, 1);
  if (scene.rocks) {
    ctx.fillStyle = "#4b4644";
    for (const [rx, ry, rw] of [[4, 60, 9], [92, 64, 12], [100, 56, 6]]) {
      ctx.fillRect(rx, ry, rw, 4);
      ctx.fillRect(rx + 1, ry - 2, rw - 3, 2);
    }
  }

  // nest of pebbles with eggs (Clutch Completion: Yes = 2 eggs, No = 1)
  const nestX = 20;
  const nestY = 74;
  ctx.fillStyle = "#6e665f";
  for (let i = 0; i < 18; i++) ctx.fillRect(nestX - 9 + i, nestY + (i % 3 === 0 ? 1 : 0), 1, 2);
  ctx.fillStyle = "#8d857c";
  for (let i = 0; i < 18; i += 2) ctx.fillRect(nestX - 9 + i, nestY - 1, 1, 1);
  const eggs = record["Clutch Completion"] === "Yes" ? 2 : record["Clutch Completion"] === "No" ? 1 : 0;
  for (let e = 0; e < eggs; e++) {
    const ex = nestX - 4 + e * 6;
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(ex, nestY - 6, 4, 6);
    ctx.fillRect(ex - 1, nestY - 5, 6, 4);
    ctx.fillStyle = "#e9efe0";
    ctx.fillRect(ex, nestY - 5, 4, 5);
    ctx.fillStyle = "#c9d3c0";
    ctx.fillRect(ex + 2, nestY - 3, 2, 2);
  }

  // food (trophic level, Delta 15 N): krill below ~8.8, fish above
  const d15 = num(record, "Delta 15 N (o/oo)");
  const fishiness = norm(d15, 7.8, 10);
  const fx = 92;
  const fy = 74;
  if (fishiness > 0.45) {
    const len = 6 + Math.round(5 * fishiness);
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(fx - 1, fy - 3, len + 2, 5);
    ctx.fillStyle = "#9fb8c8";
    ctx.fillRect(fx, fy - 2, len, 3);
    ctx.fillStyle = "#cfe0ea";
    ctx.fillRect(fx, fy - 2, len, 1);
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(fx + len + 1, fy - 4, 1, 7);
    ctx.fillRect(fx + 1, fy - 2, 1, 1);
  } else {
    const n = 1 + Math.round(3 * (1 - fishiness));
    for (let k = 0; k < n; k++) {
      const kx = fx - 2 + k * 5;
      const ky = fy - (k % 2) * 3;
      ctx.fillStyle = "#e0573f";
      ctx.fillRect(kx, ky, 4, 1);
      ctx.fillRect(kx + 1, ky - 1, 2, 1);
      ctx.fillStyle = OUTLINE;
      ctx.fillRect(kx + 3, ky - 1, 1, 1);
    }
  }

  // shadow + penguin, gently bobbing
  const bob = Math.floor(frame / 8) % 2;
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.fillRect(SCENE_W / 2 - 16, 78, 34, 2);
  const blink = frame % 70 > 66;
  penguinPixels(record, { blink, fallbacks: opts.fallbacks }).drawTo(ctx, SCENE_W / 2 - 32, 20 + bob);

  // speech bubble when body measurements are missing ("Adult not sampled")
  const missing = ["Culmen Length (mm)", "Culmen Depth (mm)", "Flipper Length (mm)", "Body Mass (g)"].some(
    (c) => !Number.isFinite(parseFloat(record[c])),
  );
  if (missing) {
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(70, 14, 11, 10);
    ctx.fillStyle = "#fff8e6";
    ctx.fillRect(71, 15, 9, 8);
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(73, 24, 2, 2);
    ctx.fillStyle = "#b8452c";
    ctx.fillRect(74, 16, 3, 1);
    ctx.fillRect(76, 17, 1, 2);
    ctx.fillRect(75, 19, 1, 1);
    ctx.fillRect(75, 21, 1, 1);
  }
}

// --- mini sprites for the colony map ----------------------------------------

export const MINI_W = 16;
export const MINI_H = 20;
const miniCache = new Map();

/**
 * A 16x20 penguin for the overview map. Body width follows body mass, height and
 * flippers follow flipper length, bill length/thickness follow the culmen, and
 * plumage/bill/feet follow the species. Sprites are cached by quantised traits.
 */
export function miniPenguin(record, fallbacks) {
  const species = shortSpecies(record.Species) || "Adelie";
  const nm = norm(num(record, "Body Mass (g)", fallbacks), 2600, 6400);
  const nf = norm(num(record, "Flipper Length (mm)", fallbacks), 170, 235);
  const nl = norm(num(record, "Culmen Length (mm)", fallbacks), 32, 60);
  const nd = norm(num(record, "Culmen Depth (mm)", fallbacks), 13, 22);
  const q = (v, steps) => Math.round(v * steps) / steps;
  const key = `${species}|${q(nm, 6)}|${q(nf, 6)}|${q(nl, 4)}|${nd > 0.5}`;
  let canvas = miniCache.get(key);
  if (canvas) return canvas;

  const style = SPECIES_STYLE[species];
  const p = new Pixels(MINI_W, MINI_H);
  const footY = 18;
  const bodyRx = 2.4 + 2.6 * q(nm, 6);
  const bodyRy = 4 + 2.4 * q(nf, 6) + 0.8 * q(nm, 6);
  const cx = 7;
  const cy = footY - 1 - bodyRy;
  p.ellipse(cx, cy, bodyRx, bodyRy, PALETTE.back);
  p.ellipse(cx + 1, cy + 0.8, bodyRx * 0.6, bodyRy - 1.3, PALETTE.belly);
  const hr = 2.2 + 0.5 * q(nm, 6);
  const hx = cx + 1;
  const hy = cy - bodyRy + hr * 0.6;
  p.ellipse(hx, hy, hr, hr, PALETTE.back);
  const ex = Math.round(hx + 1);
  const ey = Math.round(hy - 0.5);
  if (species === "Chinstrap") {
    p.ellipse(hx + 0.5, hy + 0.8, hr - 0.4, hr - 1, PALETTE.belly, (x, y) => y >= ey);
    p.line(hx - 1, ey + 2, hx + 1, ey + 2, PALETTE.back);
    p.set(ex, ey, PALETTE.eye);
  } else if (species === "Gentoo") {
    p.set(ex - 1, ey - 1, PALETTE.belly);
    p.set(ex, ey - 1, PALETTE.belly);
  } else {
    p.set(ex, ey, PALETTE.belly);
  }
  const billLen = 1 + Math.round(2.5 * q(nl, 4));
  const bx = Math.round(hx + hr);
  const by = Math.round(hy + 0.5);
  for (let i = 0; i < billLen; i++) {
    p.set(bx + i, by, style.bill);
    if (nd > 0.5 && i < billLen - 1) p.set(bx + i, by + 1, style.bill);
  }
  const fl = 2 + Math.round(3 * q(nf, 6));
  p.line(cx - bodyRx + 0.5, cy - 1, cx - bodyRx - 0.5, cy - 1 + fl, PALETTE.backLight);
  p.set(cx - 1, footY, style.feet);
  p.set(cx + 2, footY, style.feet);
  p.outline(OUTLINE);

  canvas = document.createElement("canvas");
  canvas.width = MINI_W;
  canvas.height = MINI_H;
  p.drawTo(canvas.getContext("2d"));
  miniCache.set(key, canvas);
  return canvas;
}

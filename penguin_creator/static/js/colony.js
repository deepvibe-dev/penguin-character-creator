// Pixel-art overview map of the whole colony.
//
// The map is a schematic of the Palmer Archipelago next to Palmer Station on
// Anvers Island: Torgersen sits right off the station, Dream to the north-west
// and the Biscoe Points to the south-east. Every penguin in the dataset is drawn
// on its own island, grouped into one sub-colony per species. Islands grow with
// their population so everyone fits.
import { miniPenguin, shortSpecies, MINI_W, MINI_H } from "./sprite.js";

const SPECIES_ORDER = ["Adelie", "Chinstrap", "Gentoo"];

// Relative position of each island around Torgersen (schematic, north is up).
const ANCHORS = {
  Torgersen: [0, 0],
  Dream: [-1, -0.15],
  Biscoe: [0.75, 0.75],
};
const FALLBACK_ANCHORS = [[-0.7, 0.9], [0.1, 1], [1, -0.1], [-1, 0.7]];

const LAND = {
  Biscoe: { snow: [238, 244, 248], rock: [150, 160, 170], shore: [96, 110, 124] },
  Dream: { snow: [219, 214, 230], rock: [140, 130, 156], shore: [96, 88, 112] },
  Torgersen: { snow: [208, 206, 202], rock: [112, 106, 100], shore: [78, 74, 70] },
  _: { snow: [226, 232, 236], rock: [140, 148, 156], shore: [96, 104, 112] },
};
const SEA = [33, 76, 128];
const SEA_LIGHT = [52, 102, 160];
const SHALLOW = [74, 136, 178];
const GLACIER = [244, 248, 251];
const GLACIER_SHADE = [206, 222, 234];

const SPACING = 5.6; // phyllotaxis spacing; nearest neighbours end up ~10px apart
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

function hash(n) {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}
function noise(x, y, seed = 0) {
  return Math.sin(x * 0.21 + seed) * 0.5 + Math.sin(y * 0.17 + seed * 1.7) * 0.5 + Math.sin((x + y) * 0.09 + seed * 0.3);
}
function nestKey(rec) {
  const m = /^N(\d+)A(\d+)$/.exec(rec["Individual ID"] || "");
  return m ? +m[1] * 10 + +m[2] : 1e9;
}

/** Group records into islands -> species clusters, with positions relative to each island. */
function layoutIslands(records) {
  const byIsland = new Map(Object.keys(ANCHORS).map((name) => [name, []]));
  records.forEach((rec, index) => {
    const island = rec.Island || "Unknown island";
    if (!byIsland.has(island)) byIsland.set(island, []);
    byIsland.get(island).push({ rec, index });
  });

  const islands = [];
  let fallback = 0;
  for (const [name, members] of byIsland) {
    const groups = new Map();
    for (const m of members) {
      const sp = shortSpecies(m.rec.Species) || m.rec.Species || "Unknown";
      if (!groups.has(sp)) groups.set(sp, []);
      groups.get(sp).push(m);
    }
    const order = [...groups.keys()].sort((a, b) => {
      const ia = SPECIES_ORDER.indexOf(a);
      const ib = SPECIES_ORDER.indexOf(b);
      return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib) || a.localeCompare(b);
    });
    // place the species clusters side by side, slightly staggered
    const clusters = [];
    let x = 0;
    order.forEach((sp, i) => {
      const list = groups.get(sp).sort((a, b) => nestKey(a.rec) - nestKey(b.rec) || a.index - b.index);
      const r = SPACING * Math.sqrt(list.length) + 12;
      if (i > 0) x += r;
      const cy = i % 2 ? r * 0.35 : -r * 0.15;
      const penguins = list.map((m, k) => {
        const rad = SPACING * Math.sqrt(k + 0.5);
        const ang = k * GOLDEN;
        return { ...m, x: x + Math.cos(ang) * rad + (hash(m.index) - 0.5) * 2, y: cy + Math.sin(ang) * rad * 0.8 + (hash(m.index + 7) - 0.5) * 2 };
      });
      clusters.push({ species: sp, x, y: cy, r, penguins });
      x += r + 8;
    });
    if (!clusters.length) clusters.push({ species: null, x: 0, y: 0, r: 16, penguins: [] });
    // centre the island on its clusters
    const minX = Math.min(...clusters.map((c) => c.x - c.r));
    const maxX = Math.max(...clusters.map((c) => c.x + c.r));
    const shift = (minX + maxX) / 2;
    for (const c of clusters) {
      c.x -= shift;
      for (const p of c.penguins) p.x -= shift;
    }
    // half-width / top / bottom of the land, including the shore
    const hw = Math.max(...clusters.map((c) => Math.abs(c.x) + c.r)) + 12;
    const top = Math.min(...clusters.map((c) => c.y - c.r * 0.82)) - 10;
    const bottom = Math.max(...clusters.map((c) => c.y + c.r * 0.82)) + 10;
    const anchor = ANCHORS[name] || FALLBACK_ANCHORS[fallback++ % FALLBACK_ANCHORS.length];
    islands.push({ name, members, clusters, hw, top, bottom, anchor, seed: islands.length * 3.1 + 1 });
  }
  const GAP = 30;
  const overlaps = (a, b) =>
    Math.abs(a.cx - b.cx) < a.hw + b.hw + GAP && a.cy + a.top < b.cy + b.bottom + GAP && b.cy + b.top < a.cy + a.bottom + GAP;

  // position islands around Torgersen along their real-world directions
  const home = islands.find((i) => i.name === "Torgersen");
  for (const isl of islands) {
    if (isl === home) {
      isl.cx = 0;
      isl.cy = 0;
      continue;
    }
    const [ax, ay] = isl.anchor;
    const len = Math.hypot(ax, ay) || 1;
    let d = 0;
    const place = () => {
      isl.cx = (ax / len) * d;
      isl.cy = (ay / len) * d;
    };
    place();
    // slide outwards along the real-world direction until it overlaps nothing
    for (let guard = 0; guard < 2000; guard++) {
      if (!islands.some((o) => o !== isl && o.cx !== undefined && overlaps(o, isl))) break;
      d += 6;
      place();
    }
  }
  return islands;
}

/** Signed "landness" of a world point for one island: > 0 is land. */
function islandField(isl, x, y) {
  let best = -Infinity;
  const n = noise(x, y, isl.seed) * 3.2;
  const cs = isl.clusters;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    const dx = x - (isl.cx + c.x);
    const dy = (y - (isl.cy + c.y)) / 0.82;
    best = Math.max(best, c.r + 6 + n - Math.hypot(dx, dy));
    if (i > 0) {
      // land bridge between neighbouring sub-colonies
      const a = cs[i - 1];
      const ax = isl.cx + a.x;
      const ay = isl.cy + a.y;
      const bx = isl.cx + c.x;
      const by = isl.cy + c.y;
      const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2 || 1)));
      const px = ax + (bx - ax) * t;
      const py = ay + (by - ay) * t;
      best = Math.max(best, Math.min(a.r, c.r) * 0.7 + n - Math.hypot(x - px, y - py));
    }
  }
  return best;
}

/**
 * Render the colony map into `stage` (a positioned element).
 * options: scale, assess(record) -> {level}, markUnusual, fallbacks(record), onSelect(record), selected
 */
export function renderColony(stage, records, options = {}) {
  const islands = layoutIslands(records);

  // world bounds (+ room for Anvers Island along the top)
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const isl of islands) {
    minX = Math.min(minX, isl.cx - isl.hw);
    maxX = Math.max(maxX, isl.cx + isl.hw);
    minY = Math.min(minY, isl.cy + isl.top - 18); // room for the island label
    maxY = Math.max(maxY, isl.cy + isl.bottom + 12);
  }
  const margin = 34;
  const mainland = 46;
  const W = Math.max(360, Math.ceil(maxX - minX + margin * 2));
  const H = Math.ceil(maxY - minY + margin * 2 + mainland);
  const ox = margin - minX + (W - (maxX - minX + margin * 2)) / 2;
  const oy = margin + mainland - minY;
  const home = islands.find((i) => i.name === "Torgersen");
  const stationX = Math.round(ox + home.cx + 6);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.className = "colony-canvas";
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(W, H);
  const px = img.data;

  // terrain, one pixel at a time
  const coast = mainland - 14;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const wx = x - ox;
      const wy = y - oy;
      let color;
      // Anvers Island: glacier along the top edge, with a cove at the station
      const edge = coast + Math.sin(x * 0.045) * 6 + Math.sin(x * 0.13 + 2) * 3 - Math.max(0, 14 - Math.abs(x - stationX) * 0.5);
      if (y < edge) {
        color = (x * 7 + y * 3) % 23 === 0 || y > edge - 2 ? GLACIER_SHADE : GLACIER;
      } else {
        let field = -Infinity;
        let owner = null;
        for (const isl of islands) {
          if (Math.abs(wx - isl.cx) > isl.hw + 12 || wy < isl.cy + isl.top - 12 || wy > isl.cy + isl.bottom + 12) continue;
          const f = islandField(isl, wx, wy);
          if (f > field) {
            field = f;
            owner = isl;
          }
        }
        const pal = owner ? LAND[owner.name] || LAND._ : LAND._;
        const shoreToMainland = y - edge;
        if (field > 1.5) color = hash(x * 131 + y * 7) < 0.06 || noise(wx * 2.3, wy * 2.3, 4) > 1.55 ? pal.rock : pal.snow;
        else if (field > 0) color = pal.shore;
        else if (field > -5 || shoreToMainland < 4) color = SHALLOW;
        else color = (y * 5 + (x >> 2) * 3) % 41 === 0 && x % 4 !== 0 ? SEA_LIGHT : SEA;
      }
      const i = (y * W + x) * 4;
      px[i] = color[0];
      px[i + 1] = color[1];
      px[i + 2] = color[2];
      px[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Palmer Station: a little red hut on the coast
  const sy = mainland - 30;
  ctx.fillStyle = "#1a1220";
  ctx.fillRect(stationX - 6, sy - 1, 13, 9);
  ctx.fillStyle = "#c8452f";
  ctx.fillRect(stationX - 5, sy, 11, 7);
  ctx.fillStyle = "#f4d8a8";
  ctx.fillRect(stationX - 3, sy + 2, 2, 2);
  ctx.fillRect(stationX + 2, sy + 2, 2, 2);

  // penguins, back to front
  const placed = [];
  for (const isl of islands) {
    for (const c of isl.clusters) {
      for (const p of c.penguins) placed.push({ ...p, x: Math.round(ox + isl.cx + p.x), y: Math.round(oy + isl.cy + p.y) });
    }
  }
  placed.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const p of placed) {
    const sprite = miniPenguin(p.rec, options.fallbacks ? options.fallbacks(p.rec) : undefined);
    ctx.drawImage(sprite, p.x - (MINI_W >> 1), p.y - MINI_H + 2);
    if (options.markUnusual && options.assess) {
      const level = options.assess(p.rec).level;
      if (level !== "ok") {
        ctx.fillStyle = "#1a1220";
        ctx.fillRect(p.x - 1, p.y - MINI_H - 3, 3, 6);
        ctx.fillStyle = level === "bad" ? "#d1495b" : "#e0a526";
        ctx.fillRect(p.x, p.y - MINI_H - 2, 1, 2);
        ctx.fillRect(p.x, p.y - MINI_H + 1, 1, 1);
      }
    }
  }

  // --- DOM: canvas + crisp HTML labels + hover/click ---------------------------
  // Everything is laid out in logical map pixels; the camera scales the stage.
  stage.textContent = "";
  stage.style.width = `${W}px`;
  stage.style.height = `${H}px`;
  stage.append(canvas);

  const label = (text, x, y, cls) => {
    const node = document.createElement("div");
    node.className = `map-label ${cls}`;
    node.textContent = text;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    stage.append(node);
  };
  label("Anvers Island", 40, 6, "map-label-mainland");
  label("Palmer Station", stationX, sy - 12, "map-label-station");
  for (const isl of islands) {
    label(`${isl.name} · ${isl.members.length}`, ox + isl.cx, oy + isl.cy + isl.top - 14, "map-label-island");
    for (const c of isl.clusters) {
      if (!c.penguins.length) continue;
      label(`${c.species} ${c.penguins.length}`, ox + isl.cx + c.x, oy + isl.cy + c.y + c.r * 0.8 + 2, "map-label-cluster");
    }
  }

  const ring = document.createElement("div");
  ring.className = "map-ring";
  ring.hidden = true;
  const tip = document.createElement("div");
  tip.className = "map-tip";
  tip.hidden = true;
  stage.append(ring, tip);

  // spatial hash for hit-testing
  const cell = 16;
  const grid = new Map();
  for (const p of placed) {
    const k = `${Math.floor(p.x / cell)},${Math.floor((p.y - 8) / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(p);
  }
  const hit = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const y = ((e.clientY - rect.top) / rect.height) * H;
    let best = null;
    let bestD = 9;
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const p of grid.get(`${gx + i},${gy + j}`) || []) {
          const d = Math.hypot(p.x - x, p.y - 8 - y);
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
    return best;
  };
  const show = (p, e) => {
    if (!p) {
      ring.hidden = true;
      tip.hidden = true;
      canvas.style.cursor = "default";
      return;
    }
    canvas.style.cursor = "pointer";
    ring.hidden = false;
    ring.style.left = `${p.x - 8}px`;
    ring.style.top = `${p.y - MINI_H + 1}px`;
    ring.style.width = "16px";
    ring.style.height = `${MINI_H + 1}px`;
    tip.hidden = false;
    tip.textContent = options.describe ? options.describe(p.rec, p.index) : p.rec["Individual ID"];
    tip.style.left = `${p.x + 10}px`;
    tip.style.top = `${p.y - MINI_H}px`;
    const vp = stage.parentElement.getBoundingClientRect();
    tip.classList.toggle("flip", e.clientX > vp.right - 300);
  };
  canvas.addEventListener("mousemove", (e) => show(hit(e), e));
  canvas.addEventListener("mouseleave", () => show(null));
  canvas.addEventListener("click", (e) => {
    if (options.clickBlocked && options.clickBlocked()) return; // that was a drag
    const p = hit(e);
    if (p && options.onSelect) options.onSelect(p.rec);
  });

  return { width: W, height: H, count: placed.length };
}


// Generate batches of plausible penguins ("hatching a colony").
//
// Measurements are sampled from multivariate normal distributions fitted per
// species and sex to the original data (static/data/reference.json, built by
// penguin_creator/reference.py), so natural correlations survive: a heavy
// penguin also tends to have long flippers.
import {
  ISLANDS, NUMERIC_PRECISION, SEXES, SPECIES,
  formatDate, formatNumber, newRecord, studyNameForYear,
} from "./csv.js";

export const MAX_BATCH = 10000;

/** Small, fast, seedable PRNG (mulberry32). Returns floats in [0, 1). */
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  return {
    random: next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    choice: (list) => list[Math.floor(next() * list.length)],
    gauss() {
      // Box-Muller, one spare value cached
      if (spare !== null) {
        const v = spare;
        spare = null;
        return v;
      }
      let u = 0;
      while (u === 0) u = next();
      const v = next();
      const r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * v);
      return r * Math.cos(2 * Math.PI * v);
    },
  };
}

export function cholesky(matrix) {
  const n = matrix.length;
  const lower = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = 0;
      for (let k = 0; k < j; k++) s += lower[i][k] * lower[j][k];
      if (i === j) lower[i][j] = Math.sqrt(Math.max(matrix[i][i] - s, 1e-12));
      else lower[i][j] = (matrix[i][j] - s) / lower[j][j];
    }
  }
  return lower;
}

function sampleMvn(rng, mean, chol, scale) {
  const z = mean.map(() => rng.gauss());
  return mean.map((m, i) => {
    let s = 0;
    for (let k = 0; k <= i; k++) s += chol[i][k] * z[k];
    return m + scale * s;
  });
}

function weightedChoice(rng, weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  if (total <= 0) return rng.choice(entries.map(([k]) => k));
  let pick = rng.random() * total;
  for (const [key, w] of entries) {
    pick -= w;
    if (pick <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

function nextNumbers(existing) {
  const sample = Object.fromEntries(Object.keys(SPECIES).map((s) => [s, 0]));
  let nest = 0;
  for (const r of existing) {
    for (const [short, full] of Object.entries(SPECIES)) {
      if (r.Species === full) sample[short] = Math.max(sample[short], parseInt(r["Sample Number"], 10) || 0);
    }
    const m = /^N(\d+)A\d+$/.exec(r["Individual ID"] || "");
    if (m) nest = Math.max(nest, +m[1]);
  }
  return { sample, nest };
}

function addDays(d, days) {
  const dt = new Date(Date.UTC(d.y, d.m - 1, d.d + days));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/**
 * Return `count` new canonical records sampled from the real distributions.
 *
 * - species:   "Adelie" | "Chinstrap" | "Gentoo" | "mixed" (in the original proportions)
 * - sex:       "MALE" | "FEMALE" | "random" (nest-mates are then one male, one female)
 * - island:    an island name | "natural" (where that species was observed)
 * - variation: 1 = natural spread; lower = a more uniform colony
 * - seed:      integer for reproducible colonies; null for a random one
 * - existing:  records already in the dataset, so sample numbers and nest IDs continue
 * - dateStyle: "mdy" | "iso", to match the open file
 */
export function generate(ref, options = {}) {
  const {
    count = 10, species = "mixed", sex = "random", island = "natural", year = 2010,
    variation = 1, seed = null, existing = [], dateStyle = "mdy",
  } = options;
  if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH) throw new RangeError(`count must be between 1 and ${MAX_BATCH}`);
  if (species !== "mixed" && !SPECIES[species]) throw new RangeError(`unknown species "${species}"`);
  if (sex !== "random" && !SEXES.includes(sex)) throw new RangeError(`unknown sex "${sex}"`);
  if (island !== "natural" && !ISLANDS.includes(island)) throw new RangeError(`unknown island "${island}"`);
  if (!Number.isInteger(year) || year < 1900 || year > 2999) throw new RangeError("year must be between 1900 and 2999");
  if (!(variation >= 0 && variation <= 3)) throw new RangeError("variation must be between 0 and 3");
  if (seed !== null && !Number.isInteger(seed)) throw new RangeError("seed must be a whole number");

  const rng = makeRng(seed ?? Math.floor(Math.random() * 2 ** 32));
  const stats = ref.species;
  const chols = {};
  for (const [key, model] of Object.entries(ref.models)) {
    chols[key] = Object.fromEntries(Object.entries(model).map(([name, g]) => [name, cholesky(g.cov)]));
  }
  const { sample: sampleNo, nest } = nextNumbers(existing);
  let nestNo = nest;
  const speciesWeights = Object.fromEntries(Object.keys(SPECIES).map((s) => [s, stats[s].count]));
  const seasonStart = { y: year, m: 11, d: 9 };

  const records = [];
  let partner = null; // second adult of a nest, to mimic N12A1 / N12A2 pairs
  for (let n = 0; n < count; n++) {
    const sp = partner && species === "mixed" ? partner.species : species !== "mixed" ? species : weightedChoice(rng, speciesWeights);
    let nestId;
    let adult;
    let sx;
    let isl;
    if (partner && partner.species === sp) {
      nestId = partner.nest;
      adult = 2;
      sx = sex !== "random" ? sex : partner.sex === "MALE" ? "FEMALE" : "MALE";
      isl = island !== "natural" ? island : partner.island;
      partner = null;
    } else {
      nestNo += 1;
      nestId = nestNo;
      adult = 1;
      sx = sex !== "random" ? sex : rng.choice(SEXES);
      isl = island !== "natural" ? island : weightedChoice(rng, stats[sp].islands);
      partner = { species: sp, nest: nestId, sex: sx, island: isl };
    }

    sampleNo[sp] += 1;
    const record = newRecord({
      studyName: studyNameForYear(year),
      "Sample Number": String(sampleNo[sp]),
      Species: SPECIES[sp],
      Region: "Anvers",
      Island: isl,
      Stage: "Adult, 1 Egg Stage",
      "Individual ID": `N${nestId}A${adult}`,
      "Clutch Completion": rng.random() < stats[sp].clutch_yes_rate ? "Yes" : "No",
      "Date Egg": formatDate(addDays(seasonStart, rng.int(0, 24)), dateStyle),
      Sex: sx,
      year: String(year),
    });
    const key = `${sp}|${sx}`;
    for (const [name, group] of Object.entries(ref.models[key])) {
      const values = sampleMvn(rng, group.mean, chols[key][name], variation);
      group.columns.forEach((col, i) => {
        let value = values[i];
        if (col === "Body Mass (g)") value = Math.round(value / 25) * 25; // field scales read in 25 g steps
        const lim = ref.limits[col];
        record[col] = formatNumber(Math.min(lim.max, Math.max(lim.min, value)), NUMERIC_PRECISION[col]);
      });
    }
    records.push(record);
  }
  return records;
}

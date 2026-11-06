// Penguin Creator front end. Plain ES modules, no build step, no dependencies.
import { drawScene, drawThumbnail, shortSpecies, SPECIES_FULL } from "./sprite.js";

const LTER_COLUMNS = [
  "studyName", "Sample Number", "Species", "Region", "Island", "Stage", "Individual ID",
  "Clutch Completion", "Date Egg", "Culmen Length (mm)", "Culmen Depth (mm)",
  "Flipper Length (mm)", "Body Mass (g)", "Sex", "Delta 15 N (o/oo)", "Delta 13 C (o/oo)", "Comments",
];
const SIMPLE_COLUMNS = ["species", "island", "bill_length_mm", "bill_depth_mm", "flipper_length_mm", "body_mass_g", "sex", "year"];
const STANDARD_COLUMNS = new Set([...LTER_COLUMNS, ...SIMPLE_COLUMNS, "", "rowid", "Unnamed: 0", "index"]);

const MEASURE_LABELS = {
  "Culmen Length (mm)": ["Bill length", "mm"],
  "Culmen Depth (mm)": ["Bill depth", "mm"],
  "Flipper Length (mm)": ["Flipper length", "mm"],
  "Body Mass (g)": ["Body mass", "g"],
  "Delta 15 N (o/oo)": ["δ15N", "‰", "Nitrogen isotope ratio: higher means the penguin eats higher up the food chain (fish rather than krill)."],
  "Delta 13 C (o/oo)": ["δ13C", "‰", "Carbon isotope ratio: higher means foraging closer to shore, lower means offshore."],
};
const SPECIES_LIST = ["Adelie", "Chinstrap", "Gentoo"];
const ISLAND_LIST = ["Biscoe", "Dream", "Torgersen"];
const SEX_LIST = ["MALE", "FEMALE", ""];
const CLUTCH_LIST = ["Yes", "No", ""];
const PAGE_SIZE = 25;
const STORAGE_KEY = "penguin-creator:colony:v1";

const DEFAULT_DIALECT = {
  layout: "lter", header: LTER_COLUMNS, na: "", newline: "\n", trailing_newline: false,
  date_style: "mdy", sex_style: "upper", float_style: "plain", index_column: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
};

const state = {
  ref: null,
  dialect: { ...DEFAULT_DIALECT },
  records: [],
  filename: null,
  dirty: false,
  workspace: null,
  editing: null, // record object being edited, or null for a new penguin
  draft: null,
  draftDirty: false,
  measuresTouched: false, // has the user moved a slider on this draft?
  fieldsFor: null, // draft the field inputs currently show
  page: 0,
  checked: new Set(),
  frame: 0,
};

// ---------------------------------------------------------------------------
// formatting helpers (mirror penguin_creator/dataset.py)

function fmt(value, precision) {
  if (!Number.isFinite(value)) return "";
  let text = (Math.round(value * 10 ** precision) / 10 ** precision).toFixed(precision);
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" ? "0" : text;
}
const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && /^\s*-?\d*\.?\d+(e-?\d+)?\s*$/i.test(String(v)) ? n : null;
};

function parseDate(text) {
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text || "");
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return { y, m: +m[1], d: +m[2] };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text || "");
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  return null;
}
const pad = (n) => String(n).padStart(2, "0");
function formatDate(d, style) {
  if (!d) return "";
  return style === "iso" ? `${d.y}-${pad(d.m)}-${pad(d.d)}` : `${d.m}/${d.d}/${pad(d.y % 100)}`;
}
const studyNameFor = (year) => `PAL${pad(year % 100)}${pad((year + 1) % 100)}`;
function yearOf(rec) {
  const d = parseDate(rec["Date Egg"]);
  if (d) return String(d.y);
  const m = /^PAL(\d{2})\d{2}$/.exec(rec.studyName || "");
  if (m) return String(2000 + +m[1]);
  return rec.year || "";
}

const sexLabel = (s) => (s === "MALE" ? "Male" : s === "FEMALE" ? "Female" : s ? `Unknown (${s})` : "Unknown");
const sexSymbol = (s) => (s === "MALE" ? "♂" : s === "FEMALE" ? "♀" : "?");

// ---------------------------------------------------------------------------
// API

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      message = (await res.json()).error || message;
    } catch (_) { /* not json */ }
    throw new Error(message);
  }
  const type = res.headers.get("Content-Type") || "";
  return type.includes("application/json") ? res.json() : res.text();
}
const postJSON = (path, body, method = "POST") =>
  api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ---------------------------------------------------------------------------
// reference statistics & plausibility

function statsFor(rec, measure) {
  const sp = shortSpecies(rec.Species);
  if (!sp || !state.ref) return null;
  const entry = state.ref.species[sp];
  const bySex = entry.by_sex[rec.Sex];
  return (bySex && bySex[measure]) || entry.measures[measure];
}

function groupLabel(rec) {
  const sp = shortSpecies(rec.Species);
  if (!sp) return "";
  const sx = rec.Sex === "MALE" || rec.Sex === "FEMALE" ? ` ${sexLabel(rec.Sex).toLowerCase()}s` : "s";
  return `${sp}${sx}`;
}

/** Returns {level: ok|warn|bad|unknown, notes: [{level, text}]} */
function assess(rec) {
  const notes = [];
  const sp = shortSpecies(rec.Species);
  if (!sp) return { level: "unknown", notes: [{ level: "warn", text: `"${rec.Species || "(no species)"}" is not one of the three Palmer species, so I can't judge this one.` }] };
  const islandCount = state.ref.species[sp].islands[rec.Island];
  if (rec.Island && islandCount === 0) {
    const homes = Object.entries(state.ref.species[sp].islands).filter(([, n]) => n > 0).map(([i]) => i);
    notes.push({ level: "warn", text: `No ${sp} was ever recorded on ${rec.Island}; they live on ${homes.join(" and ")}.` });
  }
  for (const m of state.ref.measures) {
    const v = num(rec[m]);
    const s = statsFor(rec, m);
    if (v === null || !s) continue;
    const [label] = MEASURE_LABELS[m];
    const name = label;
    if (v < s.min || v > s.max) {
      notes.push({ level: "bad", text: `${name} ${rec[m]} is ${v < s.min ? "below" : "above"} anything measured in real ${groupLabel(rec)} (${fmt(s.min, 2)}–${fmt(s.max, 2)}).` });
    } else if (v < s.p05 || v > s.p95) {
      notes.push({ level: "warn", text: `${name} ${rec[m]} is unusually ${v < s.p05 ? "low" : "high"} for ${groupLabel(rec)}.` });
    }
  }
  const level = notes.some((n) => n.level === "bad") ? "bad" : notes.length ? "warn" : "ok";
  return { level, notes };
}

function speciesMeans(rec) {
  const out = {};
  for (const m of state.ref ? state.ref.measures : []) {
    const s = statsFor(rec, m);
    if (s) out[m] = s.mean;
  }
  return out;
}

// ---------------------------------------------------------------------------
// dataset state

function loadDataset({ dialect, records, filename }, { dirty = false } = {}) {
  state.dialect = { ...DEFAULT_DIALECT, ...(dialect || {}) };
  state.records = records || [];
  state.filename = filename || null;
  state.dirty = dirty;
  state.page = 0;
  state.checked.clear();
  newDraft();
  refreshFilters();
  renderAll();
}

function markDirty() {
  state.dirty = true;
  renderStatus();
  scheduleAutosave();
}

let autosaveTimer = null;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ dialect: state.dialect, records: state.records, filename: state.filename, dirty: state.dirty }));
    } catch (_) {
      /* storage full or unavailable: the colony still lives in this tab */
    }
  }, 400);
}

function extraColumns() {
  return (state.dialect.header || []).filter((c) => !STANDARD_COLUMNS.has(c));
}

function nextNumbers(species) {
  let sample = 0;
  let nest = 0;
  for (const r of state.records) {
    if (r.Species === species) sample = Math.max(sample, parseInt(r["Sample Number"], 10) || 0);
    const m = /^N(\d+)A\d+$/.exec(r["Individual ID"] || "");
    if (m) nest = Math.max(nest, +m[1]);
  }
  return { sample: sample + 1, nest: nest + 1 };
}

function latestYear() {
  let y = 0;
  for (const r of state.records) y = Math.max(y, parseInt(r.year || yearOf(r), 10) || 0);
  return y || new Date().getFullYear();
}

function blankRecord() {
  const rec = Object.fromEntries([...LTER_COLUMNS, "year"].map((k) => [k, ""]));
  rec.extra = Object.fromEntries(extraColumns().map((c) => [c, ""]));
  return rec;
}

function newDraft(species = "Adelie") {
  const rec = blankRecord();
  const year = latestYear();
  const full = SPECIES_FULL[species];
  const { sample, nest } = nextNumbers(full);
  Object.assign(rec, {
    studyName: studyNameFor(year),
    "Sample Number": String(sample),
    Species: full,
    Region: "Anvers",
    Island: species === "Gentoo" ? "Biscoe" : "Dream",
    Stage: "Adult, 1 Egg Stage",
    "Individual ID": `N${nest}A1`,
    "Clutch Completion": "Yes",
    "Date Egg": formatDate({ y: year, m: 11, d: 15 }, state.dialect.date_style),
    Sex: "MALE",
    year: String(year),
  });
  if (state.ref) applyTypical(rec);
  state.editing = null;
  state.draft = rec;
  state.draftDirty = false;
  state.measuresTouched = false;
  renderCreator();
  renderLedger();
}

function editRecord(rec) {
  if (state.draftDirty && !confirm("Discard the unsaved changes to the current penguin?")) return;
  state.editing = rec;
  state.draft = structuredClone(rec);
  state.draft.extra = { ...(rec.extra || {}) };
  state.draftDirty = false;
  renderCreator();
  renderLedger();
}

function applyTypical(rec) {
  for (const m of state.ref.measures) {
    const s = statsFor(rec, m);
    if (!s) continue;
    // body mass is weighed in 25 g steps
    rec[m] = m === "Body Mass (g)" ? fmt(Math.round(s.mean / 25) * 25, 0) : fmt(s.mean, state.ref.precision[m]);
  }
}

function changeDraft(mutator, touchesMeasures = false) {
  mutator(state.draft);
  if (touchesMeasures) state.measuresTouched = true;
  state.draftDirty = true;
  renderCreator();
}

function saveDraft(asNew = false) {
  const draft = state.draft;
  if (draft["Date Egg"] || draft.studyName) draft.year = yearOf(draft) || draft.year;
  if (state.editing && !asNew) {
    Object.assign(state.editing, structuredClone(draft));
    toast("Penguin updated.");
  } else {
    const rec = structuredClone(draft);
    if (state.editing && asNew) {
      const { sample, nest } = nextNumbers(rec.Species);
      rec["Sample Number"] = String(sample);
      rec["Individual ID"] = `N${nest}A1`;
    }
    state.records.push(rec);
    state.editing = rec;
    state.page = Math.floor((filteredRecords().indexOf(rec)) / PAGE_SIZE);
    toast(`Welcome to the colony, ${rec["Individual ID"] || "little one"}!`);
  }
  state.draft = structuredClone(state.editing);
  state.draftDirty = false;
  refreshFilters();
  markDirty();
  renderAll();
}

function deleteRecords(list) {
  const doomed = new Set(list);
  if (!doomed.size) return;
  if (!confirm(`Remove ${doomed.size} penguin${doomed.size > 1 ? "s" : ""} from the colony?`)) return;
  state.records = state.records.filter((r) => !doomed.has(r));
  for (const r of doomed) state.checked.delete(r);
  if (doomed.has(state.editing)) newDraft(shortSpecies(state.editing.Species) || "Adelie");
  markDirty();
  renderAll();
}

// ---------------------------------------------------------------------------
// creator rendering

function buildSliders() {
  const box = $("#sliders");
  box.textContent = "";
  for (const m of state.ref.measures) {
    const lim = state.ref.limits[m];
    const [label, unit] = MEASURE_LABELS[m];
    const id = `slider-${m.replace(/\W+/g, "-")}`;
    const range = el("input", { type: "range", class: "range", id, min: lim.min, max: lim.max, step: lim.step, "aria-describedby": `${id}-hint` });
    const number = el("input", { type: "number", class: "input slider-num", min: lim.min, max: lim.max, step: lim.step < 0.01 ? "any" : lim.step, "aria-label": `${label} value` });
    const na = el("input", { type: "checkbox" });
    const row = el(
      "div",
      { class: "slider", dataset: { measure: m } },
      el("div", { class: "slider-top" },
        el("label", { class: "slider-name", for: id, title: MEASURE_LABELS[m][2] || m }, `${label} `, el("small", {}, `(${unit})`)),
        number,
      ),
      range,
      el("div", { class: "slider-foot" },
        el("div", { class: "slider-hint", id: `${id}-hint` }),
        el("label", { class: "slider-na", title: "Mark this measurement as missing (NA)" }, na, "missing"),
      ),
    );
    const precision = state.ref.precision[m];
    range.addEventListener("input", () => changeDraft((d) => { d[m] = fmt(parseFloat(range.value), precision); }, true));
    number.addEventListener("change", () => {
      const v = parseFloat(number.value);
      changeDraft((d) => { d[m] = Number.isFinite(v) ? fmt(v, precision) : ""; }, true);
    });
    na.addEventListener("change", () => changeDraft((d) => {
      if (na.checked) d[m] = "";
      else {
        const s = statsFor(d, m);
        d[m] = fmt(s ? s.mean : (lim.min + lim.max) / 2, precision);
      }
    }, true));
    box.append(row);
  }
}

function trackGradient(m, rec) {
  const lim = state.ref.limits[m];
  const s = statsFor(rec, m);
  const base = "var(--track)";
  if (!s) return base;
  const pct = (v) => Math.max(0, Math.min(100, ((v - lim.min) / (lim.max - lim.min)) * 100)).toFixed(2) + "%";
  const seen = "var(--band-seen)";
  const typ = "var(--band-typical)";
  const meanL = ((s.mean - lim.min) / (lim.max - lim.min)) * 100;
  return `linear-gradient(to right, ${base} 0 ${pct(s.min)}, ${seen} ${pct(s.min)} ${pct(s.p05)}, ${typ} ${pct(s.p05)} ${(meanL - 0.6).toFixed(2)}%, var(--line) ${(meanL - 0.6).toFixed(2)}% ${(meanL + 0.6).toFixed(2)}%, ${typ} ${(meanL + 0.6).toFixed(2)}% ${pct(s.p95)}, ${seen} ${pct(s.p95)} ${pct(s.max)}, ${base} ${pct(s.max)} 100%)`;
}

function renderSliders() {
  const rec = state.draft;
  for (const row of document.querySelectorAll(".slider")) {
    const m = row.dataset.measure;
    const range = $(".range", row);
    const number = $(".slider-num", row);
    const na = $(".slider-na input", row);
    const hint = $(".slider-hint", row);
    const v = num(rec[m]);
    const s = statsFor(rec, m);
    range.style.setProperty("--band", trackGradient(m, rec));
    range.disabled = v === null;
    na.checked = v === null;
    if (v !== null) range.value = v;
    else if (s) range.value = s.mean;
    if (document.activeElement !== number) number.value = v === null ? "" : rec[m];
    number.disabled = v === null;
    const precision = Math.min(2, state.ref.precision[m]);
    let status = "";
    range.classList.remove("warn", "bad");
    if (v !== null && s) {
      if (v < s.min || v > s.max) {
        status = "bad";
        range.classList.add("bad");
      } else if (v < s.p05 || v > s.p95) {
        status = "warn";
        range.classList.add("warn");
      }
    }
    hint.textContent = "";
    if (s) {
      hint.append(`Typical ${groupLabel(rec)}: ${fmt(s.p05, precision)}–${fmt(s.p95, precision)}`);
      if (status) hint.append(" · ", el("span", { class: status }, status === "bad" ? "never seen" : "unusual"));
    } else if (v === null) {
      hint.append("Missing (written as NA)");
    }
  }
}

function setupPickers() {
  const lists = {
    Species: () => SPECIES_LIST.map((s) => SPECIES_FULL[s]),
    Island: () => ISLAND_LIST,
    Sex: () => SEX_LIST,
    "Clutch Completion": () => CLUTCH_LIST,
  };
  for (const picker of document.querySelectorAll(".picker")) {
    const field = picker.dataset.field;
    for (const arrow of picker.querySelectorAll(".arrow")) {
      arrow.addEventListener("click", () => {
        const options = lists[field]();
        const current = options.indexOf(state.draft[field]);
        const dir = +arrow.dataset.dir;
        const idx = current < 0 ? (dir > 0 ? 0 : options.length - 1) : (current + dir + options.length) % options.length;
        const next = options[idx];
        changeDraft((d) => {
          d[field] = next;
          if (field === "Species" && !state.editing) {
            // keep a brand-new penguin plausible when switching species
            const sp = shortSpecies(next);
            if (state.ref.species[sp].islands[d.Island] === 0) d.Island = sp === "Gentoo" ? "Biscoe" : "Dream";
            d["Sample Number"] = String(nextNumbers(next).sample);
            if (!state.measuresTouched) applyTypical(d);
          }
          // an untouched new penguin follows the species/sex averages
          if (field === "Sex" && !state.editing && !state.measuresTouched) applyTypical(d);
        });
      });
    }
  }
}

function renderPickers() {
  const d = state.draft;
  const sp = shortSpecies(d.Species);
  const display = {
    Species: sp || d.Species || "Unknown",
    Island: d.Island || "Unknown",
    Sex: sexLabel(d.Sex),
    "Clutch Completion": d["Clutch Completion"] || "Unknown",
  };
  for (const picker of document.querySelectorAll(".picker")) {
    const out = $(".picker-value", picker);
    out.textContent = display[picker.dataset.field];
    out.classList.toggle("warn", picker.dataset.field === "Island" && !!sp && state.ref.species[sp].islands[d.Island] === 0);
  }
  const badge = $("#sex-badge");
  badge.textContent = sexSymbol(d.Sex);
  badge.className = `sex-badge ${d.Sex === "MALE" ? "male" : d.Sex === "FEMALE" ? "female" : ""}`;
  badge.title = sexLabel(d.Sex);
}

function renderFields() {
  const box = $("#fields");
  const d = state.draft;
  // don't rebuild the inputs under the user's cursor while they type
  if (state.fieldsFor === d && box.contains(document.activeElement)) return;
  state.fieldsFor = d;
  box.textContent = "";
  const simple = state.dialect.layout === "simple";
  const input = (key, label, opts = {}) => {
    const value = opts.extra ? (d.extra || {})[key] || "" : d[key] || "";
    const node = el(opts.textarea ? "textarea" : "input", {
      class: "input",
      type: opts.textarea ? undefined : opts.type || "text",
      placeholder: opts.placeholder,
      inputmode: opts.inputmode,
      dataset: { key },
      rows: opts.textarea ? 1 : undefined,
    });
    node.value = value;
    node.addEventListener("input", () => {
      state.draftDirty = true;
      if (opts.extra) d.extra = { ...(d.extra || {}), [key]: node.value };
      else d[key] = opts.transform ? opts.transform(node.value) : node.value;
      renderGuide();
      renderMode();
    });
    node.addEventListener("change", () => renderCreator());
    return el("label", { class: opts.wide ? "wide" : "" }, label, node);
  };
  if (simple) {
    box.append(input("year", "Year", { inputmode: "numeric", placeholder: "2009" }));
  } else {
    const date = parseDate(d["Date Egg"]);
    const dateOk = date || !d["Date Egg"];
    const dateLabel = el("label", {}, "Egg laid");
    const dateInput = el("input", { class: "input", type: dateOk ? "date" : "text", dataset: { key: "Date Egg" } });
    dateInput.value = dateOk ? (date ? `${date.y}-${pad(date.m)}-${pad(date.d)}` : "") : d["Date Egg"];
    dateInput.addEventListener("change", () => {
      const parsed = parseDate(dateInput.value);
      changeDraft((x) => {
        x["Date Egg"] = parsed ? formatDate(parsed, state.dialect.date_style) : dateInput.value;
        if (parsed) x.year = String(parsed.y);
      });
    });
    dateLabel.append(dateInput);
    box.append(
      input("Individual ID", "Individual ID", { placeholder: "N1A1" }),
      input("Sample Number", "Sample number", { inputmode: "numeric" }),
      input("studyName", "Study", { placeholder: "PAL0910" }),
      dateLabel,
      input("Stage", "Stage"),
      input("Region", "Region"),
      input("Comments", "Comments", { wide: true, textarea: true }),
    );
  }
  for (const col of extraColumns()) box.append(input(col, `${col} (extra column)`, { extra: true }));
  if (simple) {
    box.append(el("p", { class: "wide hint" }, "This file uses the 8-column palmerpenguins layout, so nest IDs, dates and comments are not stored. Download as “Raw LTER” to keep those too."));
  }
}

function renderGuide() {
  const d = state.draft;
  const { level, notes } = assess(d);
  const box = $("#field-guide");
  box.className = `dialog ${level === "unknown" ? "warn" : level}`;
  const p = $("#guide-text");
  p.textContent = "";
  const sp = shortSpecies(d.Species);
  const missing = state.ref.measures.filter((m) => num(d[m]) === null).map((m) => MEASURE_LABELS[m][0].replace(/^[A-Z]/, (c) => c.toLowerCase()));
  if (level === "ok") {
    const n = state.ref.species[sp].count;
    p.append(`What a fine ${sp}! Everything is within the range of the ${n} real ${sp}s measured at Palmer Station.`);
  } else {
    p.append(notes.map((n) => n.text).join(" "));
    if (level === "bad") p.append(" Try “Make typical”, or drag the sliders back into the green.");
  }
  if (missing.length) p.append(` (Not measured: ${missing.join(", ")}.)`);
  if (d.Comments) p.append(el("br"), el("i", {}, `Field note: “${d.Comments}”`));
}

function renderMode() {
  const title = $("#creator-mode");
  if (state.editing) {
    const idx = state.records.indexOf(state.editing) + 1;
    title.textContent = `Editing #${idx} ${state.draft["Individual ID"] || ""}${state.draftDirty ? " *" : ""}`;
    $("#btn-save").textContent = "Update penguin";
    $("#btn-save-new").hidden = false;
  } else {
    title.textContent = `New penguin${state.draftDirty ? " *" : ""}`;
    $("#btn-save").textContent = "Add to colony";
    $("#btn-save-new").hidden = true;
  }
  $("#btn-revert").disabled = !state.draftDirty;
}

function renderPortrait() {
  if (!state.draft) return;
  drawScene($("#portrait"), state.draft, { frame: state.frame, fallbacks: speciesMeans(state.draft) });
}

function renderCreator() {
  if (!state.draft || !state.ref) return;
  renderPickers();
  renderSliders();
  renderFields();
  renderGuide();
  renderMode();
  renderPortrait();
}

// ---------------------------------------------------------------------------
// ledger

function filteredRecords() {
  const sp = $("#filter-species").value;
  const island = $("#filter-island").value;
  const plaus = $("#filter-plausibility").value;
  const text = $("#filter-text").value.trim().toLowerCase();
  return state.records.filter((r) => {
    if (sp && r.Species !== sp) return false;
    if (island && r.Island !== island) return false;
    if (text) {
      const hay = `${r["Individual ID"]} ${r.studyName} ${r.Comments} ${r["Sample Number"]}`.toLowerCase();
      if (!hay.includes(text)) return false;
    }
    if (plaus) {
      const level = assess(r).level;
      if (plaus === "implausible" && level !== "bad") return false;
      if (plaus === "unusual" && level === "ok") return false;
    }
    return true;
  });
}

function refreshFilters() {
  const fill = (select, values, label) => {
    const current = select.value;
    select.textContent = "";
    select.append(el("option", { value: "" }, label));
    for (const v of values) select.append(el("option", { value: v }, shortSpecies(v) || v));
    select.value = values.includes(current) ? current : "";
  };
  const species = [...new Set([...SPECIES_LIST.map((s) => SPECIES_FULL[s]), ...state.records.map((r) => r.Species).filter(Boolean)])];
  const islands = [...new Set([...ISLAND_LIST, ...state.records.map((r) => r.Island).filter(Boolean)])];
  fill($("#filter-species"), species, "All species");
  fill($("#filter-island"), islands, "All islands");
}

function renderLedger() {
  const list = filteredRecords();
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  state.page = Math.max(0, Math.min(state.page, pages - 1));
  const slice = list.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
  const body = $("#ledger-body");
  body.textContent = "";
  if (!slice.length) {
    body.append(el("tr", {}, el("td", { colspan: 12, class: "empty" }, state.records.length ? "No penguins match these filters." : "The colony is empty. Create a penguin, hatch a colony or open a CSV.")));
  }
  for (const r of slice) {
    const idx = state.records.indexOf(r);
    const canvas = el("canvas", { width: 64, height: 64, "aria-hidden": "true" });
    drawThumbnail(canvas, r, { fallbacks: speciesMeans(r) });
    const { level } = assess(r);
    const check = el("input", { type: "checkbox", "aria-label": `Select penguin ${idx + 1}` });
    check.checked = state.checked.has(r);
    check.addEventListener("click", (e) => e.stopPropagation());
    check.addEventListener("change", () => {
      if (check.checked) state.checked.add(r);
      else state.checked.delete(r);
      renderBulk();
    });
    const v = (col) => (r[col] === "" || r[col] === undefined ? el("span", { class: "muted" }, "NA") : r[col]);
    const tr = el(
      "tr",
      { class: r === state.editing ? "selected" : "", onclick: () => editRecord(r), title: "Click to edit" },
      el("td", { class: "col-check" }, check),
      el("td", {}, canvas),
      el("td", {}, String(idx + 1)),
      el("td", {}, r["Individual ID"] || el("span", { class: "muted" }, "—")),
      el("td", {}, shortSpecies(r.Species) || r.Species || "?"),
      el("td", {}, r.Island || "?"),
      el("td", { title: sexLabel(r.Sex) }, sexSymbol(r.Sex)),
      el("td", {}, v("Culmen Length (mm)"), " / ", v("Culmen Depth (mm)")),
      el("td", {}, v("Flipper Length (mm)")),
      el("td", {}, v("Body Mass (g)")),
      el("td", {}, el("span", { class: `badge ${level === "unknown" ? "warn" : level}`, title: { ok: "Plausible", warn: "Unusual", bad: "Implausible", unknown: "Unknown species" }[level] }, { ok: "✓", warn: "!", bad: "✗", unknown: "?" }[level])),
      el("td", {},
        el("div", { class: "row-actions" },
          el("button", { class: "icon-btn", title: "Duplicate", "aria-label": `Duplicate penguin ${idx + 1}`, onclick: (e) => { e.stopPropagation(); duplicate(r); } }, "⧉"),
          el("button", { class: "icon-btn", title: "Delete", "aria-label": `Delete penguin ${idx + 1}`, onclick: (e) => { e.stopPropagation(); deleteRecords([r]); } }, "✕"),
        )),
    );
    body.append(tr);
  }
  $("#page-info").textContent = `Page ${state.page + 1} / ${pages}`;
  $("#page-prev").disabled = state.page === 0;
  $("#page-next").disabled = state.page >= pages - 1;
  $("#ledger-count").textContent = list.length === state.records.length ? `(${state.records.length})` : `(${list.length} of ${state.records.length})`;
  $("#select-page").checked = slice.length > 0 && slice.every((r) => state.checked.has(r));
  renderBulk();
}

function renderBulk() {
  const n = state.checked.size;
  $("#btn-delete-selected").disabled = n === 0;
  $("#selected-count").textContent = n ? `${n} selected` : "";
}

function duplicate(r) {
  const copy = structuredClone(r);
  const { sample, nest } = nextNumbers(copy.Species);
  copy["Sample Number"] = String(sample);
  copy["Individual ID"] = `N${nest}A1`;
  state.records.splice(state.records.indexOf(r) + 1, 0, copy);
  markDirty();
  renderLedger();
  toast(`Duplicated as ${copy["Individual ID"]}.`);
}

function renderStatus() {
  const s = $("#statusline");
  s.textContent = "";
  const layout = state.dialect.layout === "simple" ? "palmerpenguins layout" : "raw LTER layout";
  s.append(
    el("b", {}, state.filename || "Untitled colony"),
    ` · ${layout} · ${state.records.length} penguin${state.records.length === 1 ? "" : "s"}`,
  );
  if (extraColumns().length) s.append(` · extra columns: ${extraColumns().join(", ")}`);
  if (state.workspace) s.append(` · server file: ${state.workspace}`);
  if (state.dirty) s.append(" · ", el("span", { class: "dirty" }, "unsaved changes"));
}

function renderAll() {
  renderStatus();
  renderCreator();
  renderLedger();
}

// ---------------------------------------------------------------------------
// file operations

async function readFileText(file) {
  return await file.text();
}

async function openCsv(file, append) {
  try {
    const text = await readFileText(file);
    const parsed = await api("/api/parse", { method: "POST", headers: { "Content-Type": "text/csv" }, body: text });
    if (!append) {
      if (state.dirty && !confirm("Replace the current colony? Unsaved changes will be lost.")) return;
      loadDataset({ ...parsed, filename: file.name });
      toast(`Opened ${file.name}: ${parsed.records.length} penguins.`);
      scheduleAutosave();
      return;
    }
    // append: keep the current file layout, but adopt new extra columns
    if (!state.records.length && !state.filename) state.dialect = { ...parsed.dialect };
    const header = [...state.dialect.header];
    for (const col of parsed.dialect.header) {
      if (!STANDARD_COLUMNS.has(col) && !header.includes(col)) header.push(col);
    }
    state.dialect.header = header;
    for (const r of parsed.records) {
      if (r["Date Egg"]) {
        const d = parseDate(r["Date Egg"]);
        if (d) r["Date Egg"] = formatDate(d, state.dialect.date_style);
      }
      state.records.push(r);
    }
    refreshFilters();
    markDirty();
    renderAll();
    toast(`Appended ${parsed.records.length} penguins from ${file.name}.`);
  } catch (err) {
    toast(`Could not read ${file.name}: ${err.message}`, true);
  }
}

async function download() {
  const layout = $("#export-layout").value;
  try {
    const text = await postJSON("/api/export", { records: state.records, dialect: state.dialect, layout: layout || undefined });
    const effective = layout || state.dialect.layout;
    let name = state.filename || (effective === "simple" ? "penguins.csv" : "penguins_lter.csv");
    if (layout && layout !== state.dialect.layout) name = name.replace(/\.csv$/i, "") + (layout === "simple" ? "_palmerpenguins.csv" : "_lter.csv");
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    const a = el("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    state.dirty = false;
    renderStatus();
    scheduleAutosave();
    toast(`Downloaded ${name} (${state.records.length} penguins).`);
  } catch (err) {
    toast(`Export failed: ${err.message}`, true);
  }
}

async function saveToServer() {
  try {
    const res = await postJSON("/api/workspace", { records: state.records, dialect: state.dialect }, "PUT");
    state.dirty = false;
    renderStatus();
    scheduleAutosave();
    toast(`Saved ${res.saved} penguins to ${res.filename}.`);
  } catch (err) {
    toast(`Save failed: ${err.message}`, true);
  }
}

async function hatch(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const payload = {
    count: parseInt(data.count, 10),
    species: data.species,
    sex: data.sex,
    island: data.island,
    year: parseInt(data.year, 10),
    variation: parseFloat(data.variation),
    seed: data.seed === "" ? null : parseInt(data.seed, 10),
    dialect: state.dialect,
    existing: state.records.map((r) => ({ Species: r.Species, "Sample Number": r["Sample Number"], "Individual ID": r["Individual ID"] })),
  };
  try {
    const { records } = await postJSON("/api/generate", payload);
    const extras = extraColumns();
    for (const r of records) {
      r.extra = Object.fromEntries(extras.map((c) => [c, ""]));
      state.records.push(r);
    }
    state.page = Math.floor((state.records.length - 1) / PAGE_SIZE);
    for (const id of ["#filter-species", "#filter-island", "#filter-plausibility", "#filter-text"]) $(id).value = "";
    refreshFilters();
    markDirty();
    renderAll();
    toast(`${records.length} penguins hatched! 🐧`);
  } catch (err) {
    toast(`Hatching failed: ${err.message}`, true);
  }
}

async function roll() {
  const d = state.draft;
  const sp = shortSpecies(d.Species);
  if (!sp) return toast("Pick one of the three species first.", true);
  try {
    const { records } = await postJSON("/api/generate", {
      count: 1,
      species: sp,
      sex: d.Sex === "MALE" || d.Sex === "FEMALE" ? d.Sex : "random",
      island: ISLAND_LIST.includes(d.Island) ? d.Island : "natural",
      year: parseInt(yearOf(d), 10) || latestYear(),
    });
    changeDraft((x) => {
      for (const m of state.ref.measures) x[m] = records[0][m];
      if (!(x.Sex === "MALE" || x.Sex === "FEMALE")) x.Sex = records[0].Sex;
    });
  } catch (err) {
    toast(err.message, true);
  }
}

let toastTimer = null;
function toast(message, error = false) {
  const t = $("#toast");
  t.textContent = message;
  t.className = `toast${error ? " error" : ""}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, error ? 6000 : 3000);
}

// ---------------------------------------------------------------------------
// wiring

function wire() {
  $("#file-open").addEventListener("change", (e) => {
    if (e.target.files[0]) openCsv(e.target.files[0], false);
    e.target.value = "";
  });
  $("#file-append").addEventListener("change", (e) => {
    if (e.target.files[0]) openCsv(e.target.files[0], true);
    e.target.value = "";
  });
  $("#btn-sample").addEventListener("click", async () => {
    if (state.dirty && !confirm("Load the original dataset? Unsaved changes will be lost.")) return;
    loadDataset(await api("/api/sample"));
    scheduleAutosave();
  });
  $("#btn-new-file").addEventListener("click", () => {
    if (state.dirty && !confirm("Start a new, empty colony? Unsaved changes will be lost.")) return;
    loadDataset({ dialect: DEFAULT_DIALECT, records: [], filename: null });
    scheduleAutosave();
  });
  $("#btn-download").addEventListener("click", download);
  $("#btn-save-server").addEventListener("click", saveToServer);

  $("#btn-save").addEventListener("click", () => saveDraft(false));
  $("#btn-save-new").addEventListener("click", () => saveDraft(true));
  $("#btn-revert").addEventListener("click", () => {
    if (state.editing) {
      state.draft = structuredClone(state.editing);
      state.draftDirty = false;
      renderCreator();
    } else newDraft(shortSpecies(state.draft.Species) || "Adelie");
  });
  $("#btn-typical").addEventListener("click", () => changeDraft((d) => applyTypical(d)));
  $("#btn-randomize").addEventListener("click", roll);

  for (const id of ["#filter-species", "#filter-island", "#filter-plausibility"]) {
    $(id).addEventListener("change", () => { state.page = 0; renderLedger(); });
  }
  $("#filter-text").addEventListener("input", () => { state.page = 0; renderLedger(); });
  $("#page-prev").addEventListener("click", () => { state.page--; renderLedger(); });
  $("#page-next").addEventListener("click", () => { state.page++; renderLedger(); });
  $("#select-page").addEventListener("change", (e) => {
    const list = filteredRecords().slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
    for (const r of list) (e.target.checked ? state.checked.add(r) : state.checked.delete(r));
    renderLedger();
  });
  $("#btn-delete-selected").addEventListener("click", () => deleteRecords([...state.checked]));

  const dialog = $("#hatch-dialog");
  const form = $("#hatch-form");
  $("#btn-hatch").addEventListener("click", () => {
    form.year.value = latestYear() + 1;
    dialog.showModal();
  });
  form.variation.addEventListener("input", () => {
    $("#variation-out").textContent = `${parseFloat(form.variation.value).toFixed(1)}× natural`;
  });
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "hatch") hatch(form);
  });

  window.addEventListener("beforeunload", (e) => {
    if (state.dirty || state.draftDirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduced) {
    setInterval(() => {
      state.frame++;
      renderPortrait();
    }, 90);
  }
}

async function init() {
  wire();
  setupPickers();
  try {
    const [ref, config] = await Promise.all([api("/api/reference"), api("/api/config")]);
    state.ref = ref;
    state.workspace = config.workspace;
    buildSliders();
    $("#btn-save-server").hidden = !config.workspace;
    if (config.workspace) {
      loadDataset(await api("/api/workspace"));
      return;
    }
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch (_) {
      saved = null;
    }
    if (saved && Array.isArray(saved.records)) {
      loadDataset(saved, { dirty: !!saved.dirty });
      toast(`Restored your colony from last time (${saved.records.length} penguins).`);
    } else {
      loadDataset(await api("/api/sample"));
    }
  } catch (err) {
    toast(`Could not start: ${err.message}`, true);
  }
}

init();

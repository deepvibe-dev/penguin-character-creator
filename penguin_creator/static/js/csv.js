// Reading and writing Palmer penguins CSV files, entirely in the browser.
//
// Two column layouts exist in the wild and both are supported:
//
// * "lter"   - the raw LTER layout (17 columns, `studyName` ... `Comments`),
//              e.g. Kaggle's `penguins_lter.csv` or `penguins_raw` from the
//              R / Python palmerpenguins package.
// * "simple" - the cleaned palmerpenguins layout (`species, island,
//              bill_length_mm, ...`), including seaborn's variant without
//              `year` and files with a leading row-index column.
//
// Inside the app every penguin is a *canonical record*: an object keyed by the
// LTER column names plus `year`, whose values are strings exactly as they
// appear in a file ("" = missing), plus `extra` for columns neither layout
// knows (kept verbatim for forward compatibility).
//
// The *dialect* records the stylistic choices of the file that was read
// (missing-value token, date style, line endings, ...) so that a file read
// and written again without edits is byte-for-byte identical.
// tests/test_compatibility.py checks all of this in a real browser.

export const LTER_COLUMNS = [
  "studyName", "Sample Number", "Species", "Region", "Island", "Stage", "Individual ID",
  "Clutch Completion", "Date Egg", "Culmen Length (mm)", "Culmen Depth (mm)",
  "Flipper Length (mm)", "Body Mass (g)", "Sex", "Delta 15 N (o/oo)", "Delta 13 C (o/oo)", "Comments",
];

export const SIMPLE_COLUMNS = [
  "species", "island", "bill_length_mm", "bill_depth_mm", "flipper_length_mm", "body_mass_g", "sex", "year",
];

// simple column -> canonical (LTER) key
export const SIMPLE_TO_CANONICAL = {
  species: "Species",
  island: "Island",
  bill_length_mm: "Culmen Length (mm)",
  bill_depth_mm: "Culmen Depth (mm)",
  flipper_length_mm: "Flipper Length (mm)",
  body_mass_g: "Body Mass (g)",
  sex: "Sex",
  year: "year",
};

export const CANONICAL_KEYS = [...LTER_COLUMNS, "year"];

// short name -> full LTER name
export const SPECIES = {
  Adelie: "Adelie Penguin (Pygoscelis adeliae)",
  Chinstrap: "Chinstrap penguin (Pygoscelis antarctica)",
  Gentoo: "Gentoo penguin (Pygoscelis papua)",
};
const SPECIES_SHORT = Object.fromEntries(Object.entries(SPECIES).map(([k, v]) => [v, k]));
export const ISLANDS = ["Biscoe", "Dream", "Torgersen"];
export const SEXES = ["MALE", "FEMALE"];

// Number of decimals used by the original dataset for each measurement.
export const NUMERIC_PRECISION = {
  "Culmen Length (mm)": 1,
  "Culmen Depth (mm)": 1,
  "Flipper Length (mm)": 0,
  "Body Mass (g)": 0,
  "Delta 15 N (o/oo)": 5,
  "Delta 13 C (o/oo)": 5,
};
const INTEGER_COLUMNS = ["Sample Number", "year"];
export const INDEX_COLUMN_NAMES = ["", "rowid", "Unnamed: 0", "index"];

export class FormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "FormatError";
  }
}

export function defaultDialect() {
  return {
    layout: "lter", // "lter" | "simple"
    header: [...LTER_COLUMNS],
    na: "", // token written for missing values
    newline: "\n",
    trailing_newline: false,
    date_style: "mdy", // "mdy" (11/11/07) | "iso" (2007-11-11)
    sex_style: "upper", // "upper" | "lower" | "title"
    float_style: "plain", // "plain" (181) | "decimal" (181.0, seaborn)
    index_column: null, // name of a leading row-index column
  };
}

// ---------------------------------------------------------------------------
// numbers, dates, names

/** Format a number the way the original dataset does: rounded, trailing zeros stripped. */
export function formatNumber(value, precision) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "";
  let text = Number(value).toFixed(precision);
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text === "-0" ? "0" : text;
}

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Parse a measurement; null for missing or non-numeric text. */
export function parseNumber(text) {
  const t = String(text ?? "").trim();
  if (t === "" || t.toUpperCase() === "NA" || !NUMBER_RE.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const MDY = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? { y, m, d } : null;
}

/** Parse "11/11/07" or "2007-11-11" into {y, m, d}, or null. */
export function parseDate(text) {
  const t = String(text ?? "").trim();
  let m = MDY.exec(t);
  if (m) {
    let year = +m[3];
    if (year < 100) year += 2000;
    return validDate(year, +m[1], +m[2]);
  }
  m = ISO.exec(t);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  return null;
}

const pad2 = (n) => String(n).padStart(2, "0");

export function formatDate(d, style) {
  if (!d) return "";
  return style === "iso" ? `${d.y}-${pad2(d.m)}-${pad2(d.d)}` : `${d.m}/${d.d}/${pad2(d.y % 100)}`;
}

/** 2007 -> "PAL0708" (field seasons span two calendar years). */
export function studyNameForYear(year) {
  return `PAL${pad2(year % 100)}${pad2((year + 1) % 100)}`;
}

/** Best-effort year of a canonical record (as used by palmerpenguins). */
export function yearOf(record) {
  if (record.year) return record.year;
  const d = parseDate(record["Date Egg"]);
  if (d) return String(d.y);
  const m = /^PAL(\d{2})\d{2}$/.exec(record.studyName || "");
  if (m) return String(2000 + +m[1]);
  return "";
}

/** "Adelie Penguin (Pygoscelis adeliae)" -> "Adelie"; unknown values are returned unchanged. */
export function shortSpecies(value) {
  if (SPECIES_SHORT[value]) return SPECIES_SHORT[value];
  const first = String(value ?? "").split(" ")[0];
  return SPECIES[first] ? first : value;
}

/** The three-species short name, or null for anything else. */
export function speciesKey(value) {
  const s = shortSpecies(value);
  return SPECIES[s] ? s : null;
}

export function fullSpecies(value) {
  if (SPECIES_SHORT[value]) return value;
  const v = String(value ?? "").trim().toLowerCase();
  for (const [short, full] of Object.entries(SPECIES)) if (v === short.toLowerCase()) return full;
  return value;
}

// ---------------------------------------------------------------------------
// low-level CSV (RFC 4180, same behaviour as Python's csv module)

/** Split CSV text into rows of fields. Blank lines are skipped. */
export function readRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false; // inside a quoted section
  let started = false; // current row has content
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      started = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      started = true;
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (started || field !== "") {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = "";
      started = false;
    } else {
      field += c;
      started = true;
    }
  }
  if (quoted) throw new FormatError("The file ends inside a quoted value.");
  if (started || field !== "") {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function quoteField(value) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// ---------------------------------------------------------------------------
// reading

export function detectLayout(header) {
  let cols = [...header];
  let indexColumn = null;
  if (cols.length > 1 && INDEX_COLUMN_NAMES.includes(cols[0])) {
    indexColumn = cols[0];
    cols = cols.slice(1);
  }
  if (LTER_COLUMNS.every((c) => cols.includes(c))) return { layout: "lter", indexColumn };
  if (SIMPLE_COLUMNS.slice(0, 7).every((c) => cols.includes(c))) return { layout: "simple", indexColumn };
  const missing = LTER_COLUMNS.filter((c) => !cols.includes(c));
  throw new FormatError(
    "Not a Palmer penguins CSV: expected the LTER columns " +
      `(missing ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? "..." : ""}) ` +
      "or the simplified palmerpenguins columns (species, island, bill_length_mm, ...).",
  );
}

/** Parse CSV text into {dialect, records}. Throws FormatError for anything that isn't a penguins file. */
export function parseCsv(text) {
  if (text.startsWith("﻿")) text = text.slice(1);
  if (!text.trim()) throw new FormatError("The file is empty.");
  const rows = readRows(text);
  const header = rows[0];
  const { layout, indexColumn } = detectLayout(header);
  const rawRows = rows.slice(1);

  const dialect = {
    ...defaultDialect(),
    layout,
    header: [...header],
    newline: text.includes("\r\n") ? "\r\n" : "\n",
    trailing_newline: text.endsWith("\n"),
    index_column: indexColumn,
  };

  // Sniff the stylistic details from the data itself.
  dialect.na = rawRows.some((r) => r.includes("NA")) ? "NA" : "";

  let sexIdx;
  if (layout === "lter") {
    const dateIdx = header.indexOf("Date Egg");
    const dates = rawRows.map((r) => r[dateIdx]).filter((d) => d);
    if (dates.length && dates.every((d) => ISO.test(d))) dialect.date_style = "iso";
    sexIdx = header.indexOf("Sex");
  } else {
    sexIdx = header.indexOf("sex");
    if (!header.includes("year")) dialect.date_style = "iso";
  }
  const sexes = rawRows.map((r) => r[sexIdx]).filter((s) => s && SEXES.includes(s.toUpperCase()));
  if (sexes.length) {
    const s = sexes[0];
    const upper = s === s.toUpperCase();
    const lower = s === s.toLowerCase();
    dialect.sex_style = upper ? "upper" : lower ? "lower" : "title";
  } else if (layout === "simple") {
    dialect.sex_style = "lower";
  }
  if (layout === "simple") {
    const flipIdx = header.indexOf("flipper_length_mm");
    const flips = rawRows.map((r) => r[flipIdx]).filter((f) => f && f !== "NA");
    if (flips.length && flips.every((f) => f.includes("."))) dialect.float_style = "decimal";
  }

  const records = rawRows.map((row, i) => {
    if (row.length !== header.length) {
      throw new FormatError(`Line ${i + 2}: expected ${header.length} fields but found ${row.length}.`);
    }
    return rowToRecord(header, row, dialect);
  });
  return { dialect, records };
}

function rowToRecord(header, row, dialect) {
  const record = newRecord();
  const extra = {};
  header.forEach((col, i) => {
    let value = row[i];
    if (dialect.na && value === dialect.na) value = "";
    if (col === dialect.index_column) return;
    if (dialect.layout === "lter" && LTER_COLUMNS.includes(col)) {
      record[col] = value;
    } else if (dialect.layout === "simple" && col in SIMPLE_TO_CANONICAL) {
      const key = SIMPLE_TO_CANONICAL[col];
      if (key === "Species") value = fullSpecies(value);
      else if (key === "Sex") value = value.toUpperCase();
      record[key] = value;
    } else {
      extra[col] = value;
    }
  });
  if (dialect.layout === "lter") {
    record.year = yearOf(record);
  } else {
    // Fill the LTER-only fields that can be derived, so a conversion to the
    // raw layout is as complete as possible.
    if (/^\d+$/.test(record.year)) record.studyName = studyNameForYear(+record.year);
    record.Region = "Anvers";
  }
  record.extra = extra;
  return record;
}

// ---------------------------------------------------------------------------
// writing

function validate(record, rowNo) {
  const errors = [];
  for (const col of Object.keys(NUMERIC_PRECISION)) {
    const value = record[col] ?? "";
    if (value !== "" && value !== "." && parseNumber(value) === null) {
      errors.push(`Row ${rowNo}: '${col}' must be a number, got "${value}".`);
    }
  }
  for (const col of INTEGER_COLUMNS) {
    const value = record[col] ?? "";
    if (value && !/^-?\d+$/.test(value)) errors.push(`Row ${rowNo}: '${col}' must be a whole number, got "${value}".`);
  }
  const values = [...Object.entries(record).filter(([k]) => k !== "extra"), ...Object.entries(record.extra || {})];
  for (const [col, value] of values) {
    if (typeof value === "string" && /[\r\n]/.test(value)) errors.push(`Row ${rowNo}: '${col}' must not contain line breaks.`);
  }
  return errors;
}

function styleSex(value, dialect) {
  if (dialect.sex_style === "lower") return value.toLowerCase();
  if (dialect.sex_style === "title") return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
  return value.toUpperCase();
}

function dateMatches(value, dialect) {
  return dialect.date_style === "iso" ? ISO.test(value) : MDY.test(value);
}

export function recordToRow(record, dialect, index) {
  const extra = record.extra || {};
  return dialect.header.map((col) => {
    if (col === dialect.index_column) return String(index);
    let value;
    if (dialect.layout === "lter" && LTER_COLUMNS.includes(col)) {
      value = record[col] ?? "";
      if (col === "studyName" && !value && /^\d+$/.test(record.year || "")) value = studyNameForYear(+record.year);
      if (col === "Date Egg" && value) {
        const d = parseDate(value);
        if (d && !dateMatches(value, dialect)) value = formatDate(d, dialect.date_style);
      }
    } else if (dialect.layout === "simple" && col in SIMPLE_TO_CANONICAL) {
      const key = SIMPLE_TO_CANONICAL[col];
      value = record[key] ?? "";
      if (key === "Species") value = shortSpecies(value);
      else if (key === "Sex") value = SEXES.includes(value.toUpperCase()) ? styleSex(value, dialect) : "";
      else if (key === "year") value = yearOf(record);
      else if (key in NUMERIC_PRECISION && dialect.float_style === "decimal" && value && !value.includes(".")) {
        value += ".0"; // seaborn-style files write every measurement as a float
      }
    } else {
      value = extra[col] ?? "";
    }
    if (value === "" && dialect.na) value = dialect.na;
    return value;
  });
}

/** Serialize canonical records with `dialect` (default: Kaggle-style raw LTER). */
export function writeCsv(records, dialect = defaultDialect()) {
  const errors = records.flatMap((r, i) => validate(r, i + 1));
  if (errors.length) throw new FormatError(errors.slice(0, 10).join(" ") + (errors.length > 10 ? " ..." : ""));
  const nl = dialect.newline;
  const lines = [dialect.header, ...records.map((r, i) => recordToRow(r, dialect, i + 1))].map((row) =>
    row.map(quoteField).join(","),
  );
  return lines.join(nl) + (dialect.trailing_newline ? nl : "");
}

/** A dialect for `layout` that keeps the extra columns of `dialect`. */
export function convertDialect(dialect, layout) {
  if (!layout || layout === dialect.layout) return dialect;
  const extras = dialect.header.filter(
    (c) => !LTER_COLUMNS.includes(c) && !SIMPLE_COLUMNS.includes(c) && c !== dialect.index_column,
  );
  if (layout === "lter") {
    return { ...defaultDialect(), header: [...LTER_COLUMNS, ...extras], newline: dialect.newline };
  }
  // the palmerpenguins package's own style
  return {
    ...defaultDialect(),
    layout: "simple",
    header: [...SIMPLE_COLUMNS, ...extras],
    na: "NA",
    newline: "\n",
    trailing_newline: true,
    sex_style: "lower",
  };
}

export function newRecord(values = {}) {
  const record = Object.fromEntries(CANONICAL_KEYS.map((k) => [k, ""]));
  record.extra = {};
  return Object.assign(record, values);
}

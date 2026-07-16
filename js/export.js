const LIBRARY_HEADER_ROW = 5;
const LIBRARY_FIRST_DATA_ROW = 6;
const LOG_HEADER_ROW = 5;
const LOG_FIRST_DATA_ROW = 7;
const LIBRARY_NOTE_COL = 12; // unused col L — same slot scan_to_diary.py uses for the UNCONFIRMED flag

const LIBRARY_HEADERS = [
  'Code', "Food name — as you'd search it", 'Brand / shop', 'Barcode (EAN)',
  'Pack size', 'Typical portion (g/ml)', 'Cooking method', 'Found in Nutritics?',
  'Exact name used in Nutritics', 'Times used', 'Check',
];
const LOG_HEADERS = [
  'Day', 'Date', 'Meal', 'Time', 'Food code', 'Food name (auto)',
  'Barcode (auto)', 'Quantity', 'Unit', 'How measured', 'Any left over?', 'Notes',
];

function setCell(XLSX, ws, row, col, value) {
  if (value === undefined || value === null || value === '') return;
  const addr = XLSX.utils.encode_cell({ r: row - 1, c: col - 1 });
  ws[addr] = { t: typeof value === 'number' ? 'n' : 's', v: value };
}

function writeHeaders(XLSX, ws, headers, row) {
  headers.forEach((h, i) => setCell(XLSX, ws, row, i + 1, h));
}

/** Builds a fresh workbook matching files/nutritics-food-diary-v2.xlsx's
 * schema. Only ever writes the manual-entry columns — never the template's
 * own formula columns (Library J/K, Log F/G) — same rule scan_to_diary.py
 * follows, so the same free-row-detection bug can't recur here either.
 * Optional guideSheets ({ howToUse, lists }, from loadGuideSheets) carries
 * the template's "How to use" and "Lists" tabs through untouched. */
export function buildWorkbook(XLSX, { foods, logEntries, guideSheets }) {
  const wb = XLSX.utils.book_new();
  const lib = {};
  const log = {};

  writeHeaders(XLSX, lib, LIBRARY_HEADERS, LIBRARY_HEADER_ROW);
  writeHeaders(XLSX, log, LOG_HEADERS, LOG_HEADER_ROW);

  foods.forEach((f, i) => {
    const row = LIBRARY_FIRST_DATA_ROW + i;
    setCell(XLSX, lib, row, 1, f.code);
    setCell(XLSX, lib, row, 2, f.name);
    setCell(XLSX, lib, row, 3, f.brand);
    setCell(XLSX, lib, row, 4, f.barcode);
    if (f.packSize) setCell(XLSX, lib, row, 5, `${f.packSize}${f.packUnit || ''}`);
    if (f.typicalPortion) setCell(XLSX, lib, row, 6, f.typicalPortion);
    if (f.cookingMethod) setCell(XLSX, lib, row, 7, f.cookingMethod);
    if (f.nameUnconfirmed) setCell(XLSX, lib, row, LIBRARY_NOTE_COL, 'NAME UNCONFIRMED — verify against packet');
  });

  logEntries.forEach((e, i) => {
    const row = LOG_FIRST_DATA_ROW + i;
    setCell(XLSX, log, row, 1, e.day);
    setCell(XLSX, log, row, 2, e.date);
    setCell(XLSX, log, row, 3, e.meal);
    setCell(XLSX, log, row, 4, e.time);
    setCell(XLSX, log, row, 5, e.foodCode);
    setCell(XLSX, log, row, 8, e.quantity);
    setCell(XLSX, log, row, 9, e.unit);
    setCell(XLSX, log, row, 10, e.howMeasured);
    setCell(XLSX, log, row, 11, e.leftover);
    setCell(XLSX, log, row, 12, e.notes);
  });

  const maxLibRow = LIBRARY_FIRST_DATA_ROW + foods.length;
  const maxLogRow = LOG_FIRST_DATA_ROW + logEntries.length;
  lib['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxLibRow, c: Math.max(LIBRARY_HEADERS.length - 1, LIBRARY_NOTE_COL - 1) } });
  log['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxLogRow, c: LOG_HEADERS.length - 1 } });

  if (guideSheets?.howToUse) XLSX.utils.book_append_sheet(wb, guideSheets.howToUse, 'How to use');
  XLSX.utils.book_append_sheet(wb, lib, 'Food Library');
  XLSX.utils.book_append_sheet(wb, log, 'Daily Log');
  if (guideSheets?.lists) XLSX.utils.book_append_sheet(wb, guideSheets.lists, 'Lists');
  return wb;
}

/** Browser-only: triggers a file download. Not unit tested (no DOM in Node);
 * exercised manually in Task 11. */
export function downloadWorkbook(workbook, XLSX, filename = 'food-diary-export.xlsx') {
  XLSX.writeFile(workbook, filename);
}

/** Builds an in-memory Blob of the workbook's xlsx bytes, for use with
 * navigator.share() or anything else that wants raw file data instead of
 * triggering a download. Doesn't touch downloadWorkbook, which stays the
 * direct-download fallback path — this is purely additive. */
export function workbookToBlob(workbook, XLSX) {
  const arrayBuffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  return new Blob([arrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

const GUIDE_SHEET_TEMPLATE_URL = './assets/nutritics-food-diary-v2-template.xlsx';

// The export click handler awaits the promise this feeds, having already
// latched an in-flight guard — so an unbounded fetch here doesn't just delay
// the export, it kills the button permanently until a page reload. Bounded for
// the same reason as LOOKUP_TIMEOUT_MS: the guide sheets are supplementary, so
// giving up on them is far cheaper than a dead Export screen.
export const GUIDE_SHEET_TIMEOUT_MS = 5000;

/** Browser-only: fetches the bundled template and returns its "How to use"
 * and "Lists" sheets for buildWorkbook's optional guideSheets param. Returns
 * null on any fetch/parse/timeout failure (e.g. asset not yet cached offline) so
 * export proceeds without them rather than failing — a console.warn is the
 * only signal, no user-facing status message (the guide sheets are
 * supplementary, not the verified diary data). Always settles within
 * `timeoutMs`. `fetchImpl` is injectable for tests, mirroring lookupProduct. */
export async function loadGuideSheets(XLSX, fetchImpl = fetch, timeoutMs = GUIDE_SHEET_TIMEOUT_MS) {
  try {
    const res = await fetchImpl(GUIDE_SHEET_TEMPLATE_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      console.warn(`loadGuideSheets: template fetch failed (${res.status}) — exporting without guide sheets`);
      return null;
    }
    const buf = await res.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellStyles: true });
    return { howToUse: wb.Sheets['How to use'], lists: wb.Sheets['Lists'] };
  } catch (err) {
    console.warn('loadGuideSheets: failed to load/parse template — exporting without guide sheets', err);
    return null;
  }
}

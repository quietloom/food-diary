const OFF_URL = (code) => `https://world.openfoodfacts.org/api/v2/product/${code}.json`;

// A lookup that never responds must not strand the scan flow. The caller awaits
// this before opening the confirm card, so an unbounded fetch leaves the camera
// closed and the card never shown, with no error. The name is advisory only —
// Nutritics resolves nutrition from the barcode — so abandoning a slow lookup
// costs nothing clinically, while a stalled UI costs the dietitian real time.
export const LOOKUP_TIMEOUT_MS = 5000;

/** Advisory-only Open Food Facts lookup. Mirrors scan_to_diary.py::lookup —
 * never trusted, never used for nutrition, degrades gracefully offline. Always
 * settles within `timeoutMs`; a timeout is reported like any other network
 * failure. */
export async function lookupProduct(barcode, fetchImpl = fetch, timeoutMs = LOOKUP_TIMEOUT_MS) {
  let data;
  try {
    const resp = await fetchImpl(OFF_URL(barcode), {
      headers: { 'User-Agent': 'NHS-diary-helper/1.0 (dietetics; barcode capture PWA)' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    data = await resp.json();
  } catch (e) {
    return { name: '', brand: '', packQty: null, packUnit: '', note: `lookup unavailable (${e.name || e.constructor.name}) — barcode still valid` };
  }

  if (data.status !== 1) {
    return { name: '', brand: '', packQty: null, packUnit: '', note: 'not in Open Food Facts — Nutritics may still know it' };
  }

  const p = data.product || {};
  const name = (p.product_name_en || p.product_name || '').trim();
  const brand = (p.brands || '').split(',')[0].trim();

  let packQty = null;
  let packUnit = '';
  for (const key of ['product_quantity', 'quantity']) {
    const raw = p[key];
    if (raw) {
      const m = /([\d.]+)\s*(g|kg|ml|l)?/i.exec(String(raw));
      if (m) {
        packQty = parseFloat(m[1]);
        packUnit = (m[2] || 'g').toLowerCase();
        if (packUnit === 'kg') { packQty *= 1000; packUnit = 'g'; }
        else if (packUnit === 'l') { packQty *= 1000; packUnit = 'ml'; }
        break;
      }
    }
  }
  return { name, brand, packQty, packUnit, note: '' };
}

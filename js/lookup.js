const OFF_URL = (code) => `https://world.openfoodfacts.org/api/v2/product/${code}.json`;

/** Advisory-only Open Food Facts lookup. Mirrors scan_to_diary.py::lookup —
 * never trusted, never used for nutrition, degrades gracefully offline. */
export async function lookupProduct(barcode, fetchImpl = fetch) {
  let data;
  try {
    const resp = await fetchImpl(OFF_URL(barcode), {
      headers: { 'User-Agent': 'NHS-diary-helper/1.0 (dietetics; barcode capture PWA)' },
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

/**
 * Validate EAN-13 / EAN-8 / UPC-A using the GS1 check digit.
 * Ported from files/scan_to_diary.py::check_digit_ok — keep both in sync.
 */
export function checkDigitOk(code) {
  if (!/^\d+$/.test(code) || ![8, 12, 13].includes(code.length)) {
    return false;
  }
  if (code.length === 12) {
    code = '0' + code; // UPC-A -> pad to EAN-13
  }
  const body = code.slice(0, -1);
  const check = Number(code[code.length - 1]);
  let total = 0;
  const reversed = body.split('').reverse();
  for (let i = 0; i < reversed.length; i++) {
    total += Number(reversed[i]) * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (total % 10)) % 10 === check;
}

import { checkDigitOk } from './checkdigit.js';

const RETRY_MS = 400; // ~2.5 scans/sec — enough to feel live without pegging the CPU
const BARCODE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];

/** Decodes the first barcode found in `imageData` (an ImageData instance).
 * Prefers the native BarcodeDetector API; falls back to zxing-wasm where
 * it's unavailable (notably iOS Safari). Returns { code, checkDigitOk } for
 * the first barcode found, or null if none found. Pure decode logic with no
 * DOM dependency, shared by live-camera scanning (detectFrame, below) and
 * gallery-photo scanning (decodeImageFile) — the GS1 check-digit rule
 * ("reject, don't trust") from scan_to_diary.py::scan_photo applies
 * identically to both. */
export async function decodeBarcodeFromSource(imageData) {
  const useNative = typeof globalThis.BarcodeDetector !== 'undefined';
  let barcodes;
  if (useNative) {
    const detector = new globalThis.BarcodeDetector({ formats: BARCODE_FORMATS });
    barcodes = (await detector.detect(imageData)).map((b) => ({ text: b.rawValue }));
  } else {
    const result = await globalThis.ZXingWASM.readBarcodes(imageData);
    barcodes = result.map((r) => ({ text: r.text }));
  }
  if (barcodes.length === 0) return null;
  const code = barcodes[0].text.trim();
  return { code, checkDigitOk: checkDigitOk(code) };
}

function frameToImageData(videoEl) {
  const canvas = document.createElement('canvas');
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  canvas.getContext('2d').drawImage(videoEl, 0, 0);
  return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
}

/** Starts scanning `videoEl`'s camera feed for a barcode. Only ever calls
 * onVerifiedBarcode for a read that passes the GS1 check digit — see
 * decodeBarcodeFromSource above. Returns a stop() function that releases
 * the camera. */
export async function startScanning(videoEl, onVerifiedBarcode, onProblem) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (e) {
    onProblem(`camera unavailable (${e.name || e.message})`);
    return () => {};
  }
  videoEl.srcObject = stream;
  await videoEl.play();

  let stopped = false;
  let seenLast = null;

  async function detectFrame() {
    if (stopped) return;
    try {
      const result = await decodeBarcodeFromSource(frameToImageData(videoEl));
      if (stopped) return;
      if (result && result.code !== seenLast) {
        seenLast = result.code;
        if (result.checkDigitOk) {
          onVerifiedBarcode(result.code);
        } else {
          onProblem(`check digit FAILED for '${result.code}' — read rejected, do not trust`);
        }
      }
    } catch (e) {
      // transient per-frame decode errors are expected constantly while
      // the camera isn't pointed at a barcode — not surfaced to onProblem
    }
    if (!stopped) setTimeout(detectFrame, RETRY_MS);
  }
  detectFrame();

  return () => {
    stopped = true;
    stream.getTracks().forEach((t) => t.stop());
  };
}

/** Decodes a barcode from a picked image File (e.g. from the device's photo
 * gallery) — for missed-scan or offline-at-the-time recovery. Same
 * decode/check-digit rule as live scanning, applied to a single
 * already-taken photo instead of a video stream. Returns
 * { code, checkDigitOk }, or null if no barcode found. */
export async function decodeImageFile(file) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  const imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  return decodeBarcodeFromSource(imageData);
}

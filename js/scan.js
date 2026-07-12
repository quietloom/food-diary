import { checkDigitOk } from './checkdigit.js';

const RETRY_MS = 400; // ~2.5 scans/sec — enough to feel live without pegging the CPU

/** Starts scanning `videoEl`'s camera feed for a barcode. Prefers the native
 * BarcodeDetector API; falls back to zxing-wasm where it's unavailable
 * (notably iOS Safari). Only ever calls onVerifiedBarcode for a read that
 * passes the GS1 check digit — same "reject, don't trust" rule as
 * scan_to_diary.py::scan_photo, just applied to a live stream instead of a
 * single photo. Returns a stop() function that releases the camera. */
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

  const useNative = typeof window.BarcodeDetector !== 'undefined';
  const detector = useNative
    ? new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] })
    : null;

  let stopped = false;
  let seenLast = null;

  async function detectFrame() {
    if (stopped) return;
    try {
      let barcodes;
      if (useNative) {
        barcodes = await detector.detect(videoEl);
        barcodes = barcodes.map((b) => ({ text: b.rawValue }));
      } else {
        const canvas = document.createElement('canvas');
        canvas.width = videoEl.videoWidth;
        canvas.height = videoEl.videoHeight;
        canvas.getContext('2d').drawImage(videoEl, 0, 0);
        const imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        const result = await window.ZXingWASM.readBarcodes(imageData);
        barcodes = result.map((r) => ({ text: r.text }));
      }
      if (stopped) return;
      if (barcodes.length > 0) {
        const code = barcodes[0].text.trim();
        if (code !== seenLast) {
          seenLast = code;
          if (checkDigitOk(code)) {
            onVerifiedBarcode(code);
          } else {
            onProblem(`check digit FAILED for '${code}' — read rejected, do not trust`);
          }
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

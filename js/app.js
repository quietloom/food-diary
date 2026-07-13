import { openDb, upsertFoodByBarcode, addLogEntry, getAllFoods, getAllLogEntries, addPhoto, getAllPhotos } from './db.js';
import { lookupProduct } from './lookup.js';
import { buildWorkbook, workbookToBlob } from './export.js';
import { createTimer } from './timing.js';
import { startScanning } from './scan.js';

const todayDDMMYYYY = () => {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

const inferMeal = () => {
  const h = new Date().getHours();
  if (h < 11) return 'Breakfast';
  if (h < 15) return 'Lunch';
  if (h < 18) return 'Snack';
  return 'Dinner';
};

const SCAN_TIMEOUT_MS = 8000;

async function main() {
  const db = await openDb();
  const timer = createTimer(db);

  const menu = document.getElementById('menu');
  const menuBtn = document.getElementById('menu-btn');
  const screens = Array.from(document.querySelectorAll('.screen'));
  const confirmCard = document.getElementById('confirm-card');

  // camera stream lifecycles — only one of these may be open at a time
  let scanStop = null;
  let photoStop = null;
  let scanStarting = false; // true while getUserMedia is pending, to block re-entrant beginScan() calls
  let photoStarting = false; // true while getUserMedia is pending, to block re-entrant photo-stream opens
  let scanTimeoutId = null; // pending "can't find it? take a photo" prompt timer
  let scanCancelled = false; // set by the Cancel button; checked after a pending getUserMedia resolves, so a stream that arrives after Cancel was tapped gets stopped instead of assigned
  let currentScreen = 'scan'; // matches index.html's default-visible screen; the scan screen starts idle (no beginScan() call at load)

  const scanIdle = document.getElementById('scan-idle');
  const scanActive = document.getElementById('scan-active');
  const scanFallback = document.getElementById('scan-fallback');

  function setScanUiActive(active) {
    scanIdle.classList.toggle('hidden', active);
    scanActive.classList.toggle('hidden', !active);
    scanFallback.classList.add('hidden');
  }

  function stopScan() {
    if (scanTimeoutId) { clearTimeout(scanTimeoutId); scanTimeoutId = null; }
    if (scanStop) { scanStop(); scanStop = null; }
  }

  function showScreen(name) {
    currentScreen = name;
    screens.forEach((s) => s.classList.toggle('hidden', s.dataset.screen !== name));
    menu.classList.add('hidden');
    confirmCard.classList.add('hidden');
    if (name !== 'scan') { stopScan(); setScanUiActive(false); }
    if (name !== 'photo' && photoStop) { photoStop(); photoStop = null; }
    if (name === 'library') renderLibrary();
    if (name === 'log') renderLog();
    if (name === 'export') renderExportSummary();
    if (name === 'quick-add') renderQuickAdd();
    if (name === 'timing') renderTiming();
  }

  menuBtn.addEventListener('click', () => menu.classList.toggle('hidden'));
  document.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => showScreen(btn.dataset.nav));
  });

  // --- Confirm card -------------------------------------------------
  function openConfirmCard(food, { onLog }) {
    const isPhotoEntry = food.code === null;
    confirmCard.innerHTML = `
      <strong>${food.name || (isPhotoEntry ? '' : '(name not found — Nutritics will resolve from the barcode)')}</strong>${food.nameUnconfirmed ? ' <em>(unconfirmed name — verify against packet)</em>' : ''}${isPhotoEntry ? '' : ` (${food.code})`}
      ${isPhotoEntry ? '<label>What is it?</label><input id="cc-desc" placeholder="e.g. blueberries">' : ''}
      <label>Meal</label>
      <select id="cc-meal">
        ${['Breakfast', 'Lunch', 'Dinner', 'Snack'].map((m) => `<option ${m === inferMeal() ? 'selected' : ''}>${m}</option>`).join('')}
      </select>
      <label>Quantity</label>
      <div style="display:flex;gap:8px">
        <input id="cc-qty" type="number" value="${food.packSize ?? ''}" style="flex:2">
        <select id="cc-unit" style="flex:1"><option ${food.packUnit === 'g' ? 'selected' : ''}>g</option><option ${food.packUnit === 'ml' ? 'selected' : ''}>ml</option></select>
      </div>
      <button class="primary" id="cc-log-btn">Log it</button>
    `;
    confirmCard.classList.remove('hidden');
    document.getElementById('cc-log-btn').addEventListener('click', async () => {
      const descEl = document.getElementById('cc-desc');
      await onLog({
        meal: document.getElementById('cc-meal').value,
        quantity: parseFloat(document.getElementById('cc-qty').value) || null,
        unit: document.getElementById('cc-unit').value,
        ...(descEl ? { description: descEl.value.trim() } : {}),
        ...(food.nameUnconfirmed ? { notes: 'name unconfirmed — verify against packet' } : {}),
      });
      confirmCard.classList.add('hidden');
    });
  }

  async function logEntry({ foodCode, meal, quantity, unit, notes = '', photoRef = null }) {
    await addLogEntry(db, {
      day: 1, // single-day capture per scan session; Day/Date can be edited from the Daily Log screen for multi-day trials
      date: todayDDMMYYYY(),
      meal,
      time: new Date().toTimeString().slice(0, 5),
      foodCode,
      quantity,
      unit,
      howMeasured: '',
      leftover: '',
      notes,
      photoRef,
    });
  }

  // --- Scan screen ----------------------------------------------------
  const scanStatus = document.getElementById('scan-status');
  async function beginScan() {
    setScanUiActive(true);
    scanStarting = true;
    scanCancelled = false;
    const stop = await startScanning(
      document.getElementById('viewfinder'),
      async (barcode) => {
        stopScan();
        const looked = await lookupProduct(barcode).catch(() => ({ name: '', brand: '', packQty: null, packUnit: '', note: '' }));
        const { code, nameUnconfirmed } = await upsertFoodByBarcode(db, {
          barcode, name: looked.name, brand: looked.brand, packSize: looked.packQty, packUnit: looked.packUnit,
        });
        scanStatus.textContent = '';
        setScanUiActive(false);
        openConfirmCard({ code, name: looked.name, packSize: looked.packQty, packUnit: looked.packUnit, nameUnconfirmed }, {
          onLog: (details) => logEntry({ foodCode: code, ...details }),
        });
      },
      (msg) => { scanStatus.textContent = msg; },
    );
    scanStarting = false;
    // If the user navigated away from the scan screen, or hit Cancel, while getUserMedia
    // was pending, don't leave this stream open behind them — stop it immediately instead
    // of assigning scanStop.
    if (currentScreen !== 'scan' || scanCancelled) {
      stop();
      return;
    }
    scanStop = stop;
    scanTimeoutId = setTimeout(() => { scanFallback.classList.remove('hidden'); }, SCAN_TIMEOUT_MS);
  }

  document.getElementById('scan-idle-btn').addEventListener('click', () => {
    if (!scanStop && !scanStarting) beginScan();
  });
  document.getElementById('scan-cancel-btn').addEventListener('click', () => {
    scanCancelled = true;
    stopScan();
    setScanUiActive(false);
  });
  document.getElementById('scan-fallback-btn').addEventListener('click', () => {
    stopScan();
    showScreen('photo');
  });

  // --- Library / Log screens ------------------------------------------
  async function renderLibrary() {
    const foods = await getAllFoods(db);
    const logEntries = await getAllLogEntries(db);
    const counts = {};
    logEntries.forEach((e) => { counts[e.foodCode] = (counts[e.foodCode] || 0) + 1; });
    const tbody = document.querySelector('#library-table tbody');
    tbody.innerHTML = foods.map((f) => `<tr><td>${f.code}</td><td>${f.name || '(unnamed)'}${f.nameUnconfirmed ? ' <em>UNCONFIRMED</em>' : ''}</td><td>${f.barcode}</td><td>${counts[f.code] || 0}</td></tr>`).join('');
  }

  async function renderLog() {
    const logEntries = await getAllLogEntries(db);
    const foods = await getAllFoods(db);
    const photos = await getAllPhotos(db);
    const byCode = Object.fromEntries(foods.map((f) => [f.code, f]));
    const photoById = Object.fromEntries(photos.map((p) => [p.id, p]));
    const tbody = document.querySelector('#log-table tbody');
    tbody.innerHTML = logEntries.map((e) => {
      const food = byCode[e.foodCode];
      const name = food?.name || e.notes || e.foodCode || '(no description)';
      const unconfirmed = food?.nameUnconfirmed ? ' <em>UNCONFIRMED</em>' : '';
      let photoCell = '';
      if (e.photoRef && photoById[e.photoRef]) {
        const url = URL.createObjectURL(photoById[e.photoRef].blob);
        photoCell = `<a href="${url}" target="_blank"><img class="thumb" src="${url}"></a>`;
      }
      return `<tr><td>${e.day}</td><td>${e.meal}</td><td>${name}${unconfirmed}</td><td>${e.quantity ?? ''}${e.unit ?? ''}</td><td>${photoCell}</td></tr>`;
    }).join('');
  }

  // --- Quick-add --------------------------------------------------------
  async function renderQuickAdd() {
    const foods = await getAllFoods(db);
    const logEntries = await getAllLogEntries(db);
    const counts = {};
    logEntries.forEach((e) => { counts[e.foodCode] = (counts[e.foodCode] || 0) + 1; });
    const sorted = [...foods].sort((a, b) => (counts[b.code] || 0) - (counts[a.code] || 0));
    const tbody = document.querySelector('#quick-add-table tbody');
    function draw(list) {
      tbody.innerHTML = list.map((f) => `<tr data-code="${f.code}"><td>${f.name || f.code}${f.nameUnconfirmed ? ' <em>UNCONFIRMED</em>' : ''}</td><td>${counts[f.code] || 0}</td></tr>`).join('');
      tbody.querySelectorAll('tr').forEach((tr) => {
        tr.addEventListener('click', () => {
          const food = sorted.find((f) => f.code === tr.dataset.code);
          showScreen('scan');
          openConfirmCard(food, { onLog: (details) => logEntry({ foodCode: food.code, ...details }) });
        });
      });
    }
    draw(sorted);
    document.getElementById('quick-add-search').oninput = (e) => {
      const q = e.target.value.toLowerCase();
      draw(sorted.filter((f) => (f.name || '').toLowerCase().includes(q)));
    };
  }

  // --- No-barcode reference photo ---------------------------------------
  document.querySelector('[data-nav="photo"]').addEventListener('click', async () => {
    if (photoStop || photoStarting) return; // already open or already opening — no-op
    photoStarting = true;
    document.getElementById('photo-status').textContent = '';
    const videoEl = document.getElementById('photo-viewfinder');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      videoEl.srcObject = stream;
      await videoEl.play();
    } catch (err) {
      photoStarting = false;
      document.getElementById('photo-status').textContent = `Camera error: ${err.message || err}`;
      return;
    }
    photoStarting = false;
    const stop = () => stream.getTracks().forEach((t) => t.stop());
    // If the user navigated away from the photo screen while getUserMedia was pending,
    // don't leave this stream open behind them — stop it immediately instead of assigning photoStop.
    if (currentScreen !== 'photo') {
      stop();
      return;
    }
    photoStop = stop;
  });
  document.getElementById('photo-capture-btn').addEventListener('click', async () => {
    const videoEl = document.getElementById('photo-viewfinder');
    const canvas = document.createElement('canvas');
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    canvas.getContext('2d').drawImage(videoEl, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    const photoRef = await addPhoto(db, blob);
    if (photoStop) photoStop();
    showScreen('scan');
    openConfirmCard({ code: null, name: '' }, {
      onLog: ({ description, ...details }) =>
        logEntry({ foodCode: null, notes: description || 'reference photo — describe for the dietitian', photoRef, ...details }),
    });
  });

  // --- Export -------------------------------------------------------------
  let pendingExport = null; // built as soon as the Export screen opens, so the click handler below can fire the download/share almost synchronously with the tap

  async function buildExportFiles() {
    if (typeof window.XLSX === 'undefined') {
      throw new Error('export library not loaded — check your connection and reload the app');
    }
    const foods = await getAllFoods(db);
    const logEntries = (await getAllLogEntries(db)).map((e) =>
      e.photoRef ? { ...e, notes: `${e.notes} (see photo-${e.photoRef}.jpg)` } : e
    );
    const wb = buildWorkbook(window.XLSX, { foods, logEntries });
    const photos = await getAllPhotos(db);
    const xlsxBlob = workbookToBlob(wb, window.XLSX);
    const xlsxFile = new File([xlsxBlob], 'food-diary-export.xlsx', { type: xlsxBlob.type });
    const photoFiles = photos.map((p) => new File([p.blob], `photo-${p.id}.jpg`, { type: p.blob.type || 'image/jpeg' }));
    return { xlsxBlob, allFiles: [xlsxFile, ...photoFiles], photos };
  }

  async function renderExportSummary() {
    const foods = await getAllFoods(db);
    const logEntries = await getAllLogEntries(db);
    document.getElementById('export-summary').textContent =
      `${logEntries.length} entries across ${foods.length} distinct foods.`;
    document.getElementById('export-status').textContent = '';
    // Pre-build now, while the user is just looking at this screen — not on
    // click. Some mobile browsers silently drop a download/share triggered
    // too many async steps after the user's original tap (transient-activation
    // expiry); building ahead of time means the click handler below only has
    // to await an already-resolved promise, not several real IndexedDB reads.
    pendingExport = buildExportFiles().then(
      (result) => ({ ok: true, ...result }),
      (err) => ({ ok: false, err }),
    );
  }

  function downloadFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke after a delay, not immediately — some browsers need time to
    // actually read the blob before the URL becomes invalid.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function flashExportBtn(cls) {
    const btn = document.getElementById('export-share-btn');
    btn.classList.remove('flash-success', 'flash-error');
    btn.classList.add(cls);
    setTimeout(() => btn.classList.remove(cls), 2000);
  }

  let exportInFlight = false; // guards against a double-tap firing two overlapping downloads/shares

  document.getElementById('export-share-btn').addEventListener('click', async () => {
    if (exportInFlight) return;
    exportInFlight = true;
    const statusEl = document.getElementById('export-status');
    statusEl.textContent = '';
    try {
      const result = await pendingExport;
      if (!result || !result.ok) {
        throw (result && result.err) || new Error('export not ready — try again');
      }
      const { xlsxBlob, allFiles, photos } = result;

      if (navigator.canShare && navigator.canShare({ files: allFiles })) {
        await navigator.share({ files: allFiles, title: 'Food diary export' });
        statusEl.textContent = 'Shared.';
        flashExportBtn('flash-success');
      } else {
        // Build the download ourselves from xlsxBlob (explicit MIME type + filename)
        // rather than XLSX.writeFile's internal mechanism — on at least one real
        // Android browser (DuckDuckGo), writeFile's download was saved as a generic
        // .bin instead of .xlsx.
        downloadFile(xlsxBlob, 'food-diary-export.xlsx');
        for (const p of photos) {
          downloadFile(p.blob, `photo-${p.id}.jpg`);
        }
        statusEl.textContent = `Downloaded ${1 + photos.length} file(s) — check your Downloads folder.`;
        flashExportBtn('flash-success');
      }
    } catch (err) {
      if (err.name !== 'AbortError') { // user cancelling the share sheet is not an error
        statusEl.textContent = `Export failed — ${err.message || err}`;
        flashExportBtn('flash-error');
      }
    } finally {
      exportInFlight = false;
    }
  });

  // --- Timing ---------------------------------------------------------------
  async function renderTiming() {
    document.getElementById('timing-status').textContent = timer.isRunning() ? 'Running…' : 'Not running';
    document.getElementById('timing-toggle').textContent = timer.isRunning() ? 'End keying pass' : 'Start keying pass';
    const summary = await timer.summary();
    document.getElementById('timing-summary').textContent =
      `${summary.passCount} pass(es), ${(summary.totalMs / 60000).toFixed(1)} min total, ${summary.totalEntries} entries keyed.`;
  }
  document.getElementById('timing-toggle').addEventListener('click', async () => {
    if (timer.isRunning()) {
      const logEntries = await getAllLogEntries(db);
      await timer.stop(logEntries.length);
    } else {
      await timer.start();
    }
    renderTiming();
  });
}

main();

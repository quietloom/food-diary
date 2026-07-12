import { checkDigitOk } from './checkdigit.js';
import { openDb, upsertFoodByBarcode, addLogEntry, getAllFoods, getAllLogEntries, addPhoto } from './db.js';
import { lookupProduct } from './lookup.js';
import { buildWorkbook, downloadWorkbook } from './export.js';
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

async function main() {
  const db = await openDb();
  const timer = createTimer(db);

  const menu = document.getElementById('menu');
  const menuBtn = document.getElementById('menu-btn');
  const screens = Array.from(document.querySelectorAll('.screen'));
  const confirmCard = document.getElementById('confirm-card');

  function showScreen(name) {
    screens.forEach((s) => s.classList.toggle('hidden', s.dataset.screen !== name));
    menu.classList.add('hidden');
    confirmCard.classList.add('hidden');
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
    confirmCard.innerHTML = `
      <strong>${food.name || '(name not found — Nutritics will resolve from the barcode)'}</strong> (${food.code})
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
      await onLog({
        meal: document.getElementById('cc-meal').value,
        quantity: parseFloat(document.getElementById('cc-qty').value) || null,
        unit: document.getElementById('cc-unit').value,
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
  startScanning(
    document.getElementById('viewfinder'),
    async (barcode) => {
      const looked = await lookupProduct(barcode).catch(() => ({ name: '', brand: '', packQty: null, packUnit: '', note: '' }));
      const { code } = await upsertFoodByBarcode(db, {
        barcode, name: looked.name, brand: looked.brand, packSize: looked.packQty, packUnit: looked.packUnit,
      });
      scanStatus.textContent = '';
      openConfirmCard({ code, name: looked.name, packSize: looked.packQty, packUnit: looked.packUnit }, {
        onLog: (details) => logEntry({ foodCode: code, ...details }),
      });
    },
    (msg) => { scanStatus.textContent = msg; },
  );

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
    const byCode = Object.fromEntries(foods.map((f) => [f.code, f]));
    const tbody = document.querySelector('#log-table tbody');
    tbody.innerHTML = logEntries.map((e) => `<tr><td>${e.day}</td><td>${e.meal}</td><td>${byCode[e.foodCode]?.name || e.foodCode}</td><td>${e.quantity ?? ''}${e.unit ?? ''}</td></tr>`).join('');
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
      tbody.innerHTML = list.map((f) => `<tr data-code="${f.code}"><td>${f.name || f.code}</td><td>${counts[f.code] || 0}</td></tr>`).join('');
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
  let photoStop = null;
  document.querySelector('[data-nav="photo"]').addEventListener('click', async () => {
    const videoEl = document.getElementById('photo-viewfinder');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    videoEl.srcObject = stream;
    await videoEl.play();
    photoStop = () => stream.getTracks().forEach((t) => t.stop());
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
      onLog: (details) => logEntry({ foodCode: null, notes: 'reference photo — describe for the dietitian', photoRef, ...details }),
    });
  });

  // --- Export -------------------------------------------------------------
  async function renderExportSummary() {
    const foods = await getAllFoods(db);
    const logEntries = await getAllLogEntries(db);
    document.getElementById('export-summary').textContent =
      `${logEntries.length} entries across ${foods.length} distinct foods.`;
  }
  document.getElementById('export-btn').addEventListener('click', async () => {
    const foods = await getAllFoods(db);
    const logEntries = await getAllLogEntries(db);
    const wb = buildWorkbook(window.XLSX, { foods, logEntries });
    downloadWorkbook(wb, window.XLSX);
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

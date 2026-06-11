"use strict";

/* ---------- Konfiguration (Lanzenkirchen, Burgenland) ---------- */
const CONFIG = {
  lat: 47.70, lon: 16.18,
  tz: "Europe/Vienna",
  kWp: 10,            // PV-Anlagengroesse
  tilt: 30,           // Dachneigung (Grad) — Standardannahme
  azimuth: 0,         // 0 = Sued (Open-Meteo-Konvention)
  pr: 0.85,           // Performance Ratio (Verluste Wechselrichter/Kabel/Temp)
  baseLoadKw: 0.5,    // pauschale Hausgrundlast
  wallbox: { phases: 3, minKw: 4.1, maxKw: 11 }, // 11 kW 3-phasig, Minimum 6 A
  defaultNeedKwh: 40  // Vorgabe Ladebedarf (im UI ueberschreibbar)
};

/* aktueller Ladebedarf aus dem Eingabefeld */
function getNeedKwh() {
  const v = parseFloat(document.getElementById("need").value);
  return Number.isFinite(v) && v > 0 ? Math.min(200, v) : CONFIG.defaultNeedKwh;
}

const DAY_LABEL = ["Heute", "Morgen", "Übermorgen"];

/* ---------- Datenquellen ---------- */
async function fetchPv() {
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.search = new URLSearchParams({
    latitude: CONFIG.lat, longitude: CONFIG.lon,
    hourly: "global_tilted_irradiance,temperature_2m,cloud_cover",
    tilt: CONFIG.tilt, azimuth: CONFIG.azimuth,
    forecast_days: 3, timezone: CONFIG.tz
  }).toString();
  const r = await fetch(u);
  if (!r.ok) throw new Error("Open-Meteo HTTP " + r.status);
  const j = await r.json();
  const h = j.hourly;
  if (!h || !Array.isArray(h.time) || !Array.isArray(h.global_tilted_irradiance))
    throw new Error("Open-Meteo: unerwartetes Format");
  return h.time.map((t, i) => {
    const gti = h.global_tilted_irradiance[i] ?? 0;        // W/m^2
    const pv = Math.min(CONFIG.kWp, (gti / 1000) * CONFIG.kWp * CONFIG.pr); // kW
    const surplus = Math.max(0, pv - CONFIG.baseLoadKw);   // kW
    const chargeable = surplus >= CONFIG.wallbox.minKw;
    const chargeKw = chargeable ? Math.min(surplus, CONFIG.wallbox.maxKw) : 0;
    return {
      time: new Date(t), label: t,
      pv: round1(pv), surplus: round1(surplus),
      chargeable, chargeKw: round1(chargeKw),
      cloud: h.cloud_cover ? h.cloud_cover[i] : null
    };
  });
}

async function fetchPrices() {
  const r = await fetch("https://api.awattar.at/v1/marketdata");
  if (!r.ok) throw new Error("aWATTar HTTP " + r.status);
  const j = await r.json();
  if (!Array.isArray(j.data)) throw new Error("aWATTar: unerwartetes Format");
  return j.data
    .filter(d => typeof d.marketprice === "number")
    .map(d => ({
      time: new Date(d.start_timestamp),
      ct: d.marketprice / 10           // EUR/MWh -> ct/kWh
    }));
}

/* ---------- Empfehlungs-Logik ---------- */
// zusammenhaengende solar-ladbare Stunden zu Fenstern gruppieren
function buildSolarWindows(hours) {
  const win = [];
  let cur = null;
  for (const h of hours) {
    if (h.chargeable) {
      if (!cur) cur = { start: h.time, hours: [] };
      cur.hours.push(h);
      cur.end = new Date(h.time.getTime() + 3600e3);
    } else if (cur) { win.push(cur); cur = null; }
  }
  if (cur) win.push(cur);
  return win.map(w => {
    const kwh = w.hours.reduce((s, h) => s + h.chargeKw, 0);
    const avg = kwh / w.hours.length;
    const peak = Math.max(...w.hours.map(h => h.chargeKw));
    return { start: w.start, end: w.end, hours: w.hours.length, kwh: round1(kwh), avgKw: round1(avg), peakKw: round1(peak) };
  });
}

// guenstigstes N-Stunden-Fenster im Spotpreis (Sliding-Window)
function cheapestPriceWindow(prices, n) {
  if (prices.length < n) return null;
  let best = null;
  for (let i = 0; i + n <= prices.length; i++) {
    const slice = prices.slice(i, i + n);
    const sum = slice.reduce((s, p) => s + p.ct, 0);
    if (!best || sum < best.sum) best = { sum, start: slice[0].time, end: new Date(slice[n - 1].time.getTime() + 3600e3), avg: sum / n };
  }
  return best;
}

/* ---------- Helpers ---------- */
const round1 = x => Math.round(x * 10) / 10;
const fmtH = d => d.toLocaleTimeString("de-AT", { hour: "2-digit", minute: "2-digit" });
const fmtDay = d => DAY_LABEL[dayIndex(d)] ?? d.toLocaleDateString("de-AT", { weekday: "short" });
const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
let TODAY0;
function dayIndex(d) { return Math.round((startOfDay(d) - TODAY0) / 86400e3); }

/* ---------- Rendering ---------- */
function renderSolarCards(windows, need) {
  const el = document.getElementById("cards");
  const sum = document.getElementById("solarSummary");
  const totalSolar = round1(windows.reduce((s, w) => s + w.kwh, 0));

  if (!windows.length) {
    sum.className = "summary short";
    sum.innerHTML = `Dein Bedarf <b>${need}&nbsp;kWh</b> lässt sich in den nächsten 3 Tagen
      <b>nicht aus Solar</b> decken — kein Überschuss ≥&nbsp;4,1&nbsp;kW. Nutze unten den günstigsten Netzstrom.`;
    el.innerHTML = `<div class="card none"><span class="badge warn">kein Solar-Fenster</span>
      <div class="when">Keine quasi-gratis Ladezeit in den nächsten 3 Tagen</div>
      <div class="meta">Der Solar-Überschuss bleibt unter 4,1&nbsp;kW (3-phasiges Minimum).</div></div>`;
    return;
  }

  const covered = totalSolar >= need;
  sum.className = "summary" + (covered ? "" : " short");
  sum.innerHTML = covered
    ? `Dein Bedarf <b>${need}&nbsp;kWh</b> ist allein aus Solar deckbar — in 3 Tagen sind
       <b>${totalSolar}&nbsp;kWh</b> quasi-gratis verfügbar. Die markierten Fenster decken ihn ab.`
    : `Aus Solar verfügbar: <b>${totalSolar}&nbsp;kWh</b> in 3 Tagen — das deckt deinen Bedarf von
       <b>${need}&nbsp;kWh</b> noch nicht ganz (Rest ${round1(need - totalSolar)}&nbsp;kWh über günstigen Netzstrom unten).`;

  let cum = 0, reached = false;
  el.innerHTML = windows.map(w => {
    const di = dayIndex(w.start);
    const before = cum; cum += w.kwh;
    const justReached = !reached && cum >= need;
    if (justReached) reached = true;
    const unsure = di >= 2 ? `<span class="badge unsure">Tag&nbsp;3 — unsicher</span>` : "";
    const reach = justReached ? `<span class="badge free">deckt deine ${need} kWh</span>` : "";
    return `<div class="card">
      <span class="badge free">quasi-gratis · Solar</span>${reach}${unsure}
      <div class="when">${fmtDay(w.start)}, ${fmtH(w.start)}–${fmtH(w.end)}</div>
      <div class="big">${w.avgKw}<small> kW ⌀ (bis ${w.peakKw} kW)</small></div>
      <div class="meta">${w.hours}&nbsp;h · ca. <b>${w.kwh}&nbsp;kWh</b> Solar · kumuliert ${round1(Math.min(cum, before + w.kwh))}&nbsp;kWh</div>
    </div>`;
  }).join("");
}

function renderPvChart(hours) {
  const labels = hours.map(h => h.time);
  const greenBar = hours.map(h => h.chargeable ? h.surplus : 0);
  const amberBar = hours.map(h => h.chargeable ? 0 : h.surplus);
  const pvLine = hours.map(h => h.pv);
  const baseLine = hours.map(() => CONFIG.baseLoadKw);
  return new Chart(document.getElementById("pvChart"), {
    data: {
      labels,
      datasets: [
        { type: "bar", label: "solar-ladbar (kW)", data: greenBar, backgroundColor: "#21a25b", stack: "s", order: 3, barPercentage: 1, categoryPercentage: 1 },
        { type: "bar", label: "Überschuss zu klein (kW)", data: amberBar, backgroundColor: "#e8a33d", stack: "s", order: 3, barPercentage: 1, categoryPercentage: 1 },
        { type: "line", label: "PV-Produktion (kW)", data: pvLine, borderColor: "#c2880a", backgroundColor: "transparent", borderWidth: 2, pointRadius: 0, tension: .35, order: 1 },
        { type: "line", label: "Hausgrundlast (kW)", data: baseLine, borderColor: "#9aa7b5", borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, order: 2 }
      ]
    },
    options: timeOpts("kW")
  });
}

function renderPriceChart(prices, cheapWin) {
  if (!prices.length) {
    document.getElementById("priceChart").parentElement.innerHTML =
      `<p class="hint">Aktuell keine Spotpreise verfügbar (Tagespreise erscheinen ~13:00 für morgen).</p>`;
    return null;
  }
  const colors = prices.map(p => (cheapWin && p.time >= cheapWin.start && p.time < cheapWin.end) ? "#2f6df0" : "#bcd0f7");
  return new Chart(document.getElementById("priceChart"), {
    type: "bar",
    data: { labels: prices.map(p => p.time), datasets: [
      { label: "Spotpreis (ct/kWh)", data: prices.map(p => round1(p.ct)), backgroundColor: colors, barPercentage: 1, categoryPercentage: .92 }
    ] },
    options: timeOpts("ct/kWh")
  });
}

function renderPriceCard(cheapWin, need) {
  const el = document.getElementById("priceCards");
  if (!cheapWin) { el.innerHTML = ""; return; }
  const cost = (cheapWin.avg / 100) * need; // EUR fuer den Bedarf
  const h = Math.round((cheapWin.end - cheapWin.start) / 3600e3);
  el.innerHTML = `<div class="card grid">
    <span class="badge cheap">günstigster Netzstrom</span>
    <div class="when">${fmtDay(cheapWin.start)}, ${fmtH(cheapWin.start)}–${fmtH(cheapWin.end)}</div>
    <div class="big">${round1(cheapWin.avg)}<small> ct/kWh ⌀</small></div>
    <div class="meta">${need}&nbsp;kWh laden ≈ <b>${cost.toFixed(2)}&nbsp;€</b> Energiekosten
    (ohne Netz/Steuern) — günstigstes ${h}-h-Fenster für ${need}&nbsp;kWh bei ${CONFIG.wallbox.maxKw}&nbsp;kW.</div>
  </div>`;
}

function timeOpts(yLabel) {
  return {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    scales: {
      x: { stacked: true, grid: { display: false },
        ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12,
          callback(v) { const d = new Date(this.getLabelForValue(v)); return d.getHours() === 0 ? fmtDay(d) : fmtH(d); } } },
      y: { stacked: true, beginAtZero: true, title: { display: true, text: yLabel }, grid: { color: "#eef1f5" } }
    },
    plugins: { legend: { display: false }, tooltip: { callbacks: {
      title: items => { const d = new Date(items[0].label); return `${fmtDay(d)} ${fmtH(d)}`; } } } }
  };
}

/* ---------- Boot ---------- */
// Open-Meteo-Azimut: 0=Süd, -90=Ost, +90=West
function aziLabel(a) {
  if (a <= -75) return "Ost";
  if (a < -15) return "Südost";
  if (a <= 15) return "Süd";
  if (a < 75) return "Südwest";
  return "West";
}

function showConfig() {
  document.getElementById("config").innerHTML =
    `<b>${CONFIG.kWp} kWp</b> · Wallbox <b>${CONFIG.wallbox.maxKw} kW</b> 3-phasig<br>` +
    `Grundlast ${CONFIG.baseLoadKw} kW · ladbar ab ${CONFIG.wallbox.minKw} kW`;
}

const STATE = { hours: [], prices: [], pvChart: null, priceChart: null };

// PV neu laden, wenn Neigung/Ausrichtung geändert werden (GTI hängt davon ab)
let reloadTimer = null;
function scheduleReloadPv() {
  document.getElementById("tiltVal").textContent = CONFIG.tilt + "°";
  document.getElementById("aziVal").textContent = aziLabel(CONFIG.azimuth);
  const status = document.getElementById("status");
  status.className = "status";
  status.textContent = "Aktualisiere PV-Forecast für " + CONFIG.tilt + "° " + aziLabel(CONFIG.azimuth) + "…";
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    try {
      STATE.hours = await fetchPv();
      if (STATE.pvChart) STATE.pvChart.destroy();
      STATE.pvChart = renderPvChart(STATE.hours);
      recompute();
      status.className = "status hide";
    } catch (e) {
      status.className = "status error";
      status.textContent = "Fehler beim Aktualisieren: " + e.message;
    }
  }, 350);
}

// haengt nur vom Ladebedarf ab -> bei jeder Eingabe neu, ohne neue API-Calls
function recompute() {
  const need = getNeedKwh();
  renderSolarCards(buildSolarWindows(STATE.hours), need);

  if (STATE.prices.length) {
    const n = Math.max(1, Math.min(STATE.prices.length, Math.ceil(need / CONFIG.wallbox.maxKw)));
    const cheap = cheapestPriceWindow(STATE.prices, n);
    if (STATE.priceChart) STATE.priceChart.destroy();
    STATE.priceChart = renderPriceChart(STATE.prices, cheap);
    renderPriceCard(cheap, need);
  }
}

async function main() {
  showConfig();
  const status = document.getElementById("status");
  try {
    const [hours, prices] = await Promise.all([fetchPv(), fetchPrices()]);
    TODAY0 = startOfDay(hours[0]?.time || new Date());
    STATE.hours = hours; STATE.prices = prices;

    STATE.pvChart = renderPvChart(hours);
    recompute();                      // Karten + Preis-Chart abhaengig vom Bedarf
    document.getElementById("need").addEventListener("input", recompute);

    // Dachneigung / Ausrichtung -> PV neu laden
    document.getElementById("tilt").addEventListener("input", e => { CONFIG.tilt = +e.target.value; scheduleReloadPv(); });
    document.getElementById("azi").addEventListener("input", e => { CONFIG.azimuth = +e.target.value; scheduleReloadPv(); });

    status.classList.add("hide");
  } catch (e) {
    status.textContent = "Fehler beim Laden der Daten: " + e.message;
    status.classList.add("error");
    console.error(e);
  }
}
main();

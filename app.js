"use strict";

/* ---------- Konfiguration (Standard: Lanzenkirchen) ---------- */
const CONFIG = {
  lat: 47.736, lon: 16.220, locName: "Lanzenkirchen",
  tz: "Europe/Vienna",
  kWp: 12,            // PV-Anlagengroesse (Eingabefeld)
  tilt: 30,           // Dachneigung (Grad) — Slider
  azimuth: 0,         // 0 = Sued (Open-Meteo-Konvention) — Slider
  pr: 0.85,           // Performance Ratio
  baseLoadKw: 0.5,    // pauschale Hausgrundlast
  wallbox: { phases: 3, minKw: 4.1, maxKw: 11 }, // 11 kW 3-phasig, Minimum 6 A
  defaultNeedKwh: 40, // Vorgabe Ladebedarf
  refTariffCt: 30,    // normaler Netztarif zum Vergleich (all-in, ct/kWh)
  feedInCt: 8         // entgangene Einspeiseverguetung (Opportunitaetskosten)
};

const DAY_LABEL = ["Heute", "Morgen", "Übermorgen"];

/* ---------- Eingaben ---------- */
const $ = id => document.getElementById(id);
function numInput(id, fallback, max) {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) && v > 0 ? Math.min(max, v) : fallback;
}
const getNeedKwh = () => numInput("need", CONFIG.defaultNeedKwh, 200);
const getKwp     = () => numInput("kwp", CONFIG.kWp, 100);
const getTariff  = () => numInput("tariff", CONFIG.refTariffCt, 80);

/* ---------- Datenquellen ---------- */
// liefert die ROHEN Stunden (nur Einstrahlung) — kWp wird erst beim Ableiten angewandt
async function fetchPvRaw() {
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
  return h.time.map((t, i) => ({
    time: new Date(t),
    gti: h.global_tilted_irradiance[i] ?? 0,   // W/m^2
    cloud: h.cloud_cover ? h.cloud_cover[i] : null
  }));
}

// wendet kWp, Grundlast und Wallbox-Grenzen an (rein lokal, kein API-Call)
function derive(raw) {
  const kWp = getKwp();
  return raw.map(h => {
    const pv = Math.min(kWp, (h.gti / 1000) * kWp * CONFIG.pr); // kW
    const surplus = Math.max(0, pv - CONFIG.baseLoadKw);        // kW
    const chargeable = surplus >= CONFIG.wallbox.minKw;
    const chargeKw = chargeable ? Math.min(surplus, CONFIG.wallbox.maxKw) : 0;
    return { time: h.time, pv: round1(pv), surplus: round1(surplus), chargeable, chargeKw: round1(chargeKw) };
  });
}

// Offizielle oesterreichische Strompreisboerse EXAA (Day-Ahead, Markt AT)
// ueber eigenen CORS-Proxy-Worker, da EXAA keine CORS-Header sendet.
const PROXY = "https://suncharge-proxy.nichtagentur.workers.dev";
async function fetchExaa() {
  const r = await fetch(`${PROXY}/exaa`);
  if (!r.ok) throw new Error("EXAA HTTP " + r.status);
  const j = await r.json();
  const at = j.AT;
  if (!at || !Array.isArray(at.price) || !at.price.length) throw new Error("EXAA: keine AT-Daten");
  const hours = at.price.map(p => ({ hour: p.x - 1, ct: p.y / 10 })); // EUR/MWh -> ct/kWh
  const cts = hours.map(h => h.ct);
  const min = hours.reduce((a, b) => b.ct < a.ct ? b : a);
  const max = hours.reduce((a, b) => b.ct > a.ct ? b : a);
  return {
    day: at.auctionDay,
    avg: cts.reduce((s, c) => s + c, 0) / cts.length,
    min, max
  };
}

async function fetchPrices() {
  const r = await fetch("https://api.awattar.at/v1/marketdata");
  if (!r.ok) throw new Error("aWATTar HTTP " + r.status);
  const j = await r.json();
  if (!Array.isArray(j.data)) throw new Error("aWATTar: unerwartetes Format");
  return j.data
    .filter(d => typeof d.marketprice === "number")
    .map(d => ({ time: new Date(d.start_timestamp), ct: d.marketprice / 10 })); // EUR/MWh -> ct/kWh
}

/* ---------- Logik ---------- */
function buildSolarWindows(hours) {
  const win = []; let cur = null;
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
    return {
      start: w.start, end: w.end, hours: w.hours.length, kwh: round1(kwh),
      avgKw: round1(kwh / w.hours.length), peakKw: round1(Math.max(...w.hours.map(h => h.chargeKw)))
    };
  });
}

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
function renderSavings(totalSolar, need) {
  const el = $("savings");
  const used = Math.min(need, totalSolar);          // kWh, die du aus Solar deckst
  if (used <= 0) { el.hidden = true; return; }
  const tariff = getTariff();
  const savedGross = used * tariff / 100;           // vermiedener Netzbezug (EUR)
  const savedNet = used * (tariff - CONFIG.feedInCt) / 100;
  const rest = round1(Math.max(0, need - totalSolar));
  el.hidden = false;
  el.innerHTML =
    `<span class="amount">~${savedGross.toFixed(2)} €</span>
     <span class="label">gespart ggü. Netzbezug (${tariff} ct/kWh) — für ${round1(used)} kWh aus eigener Sonne</span>
     <span class="note">Netto ~${savedNet.toFixed(2)} € nach entgangener Einspeisung (${CONFIG.feedInCt} ct/kWh).` +
    (rest > 0 ? ` Die restlichen ${rest} kWh am besten im günstigsten Netz-Fenster unten laden.` : ` Dein ganzer Bedarf ist solar gedeckt.`) +
    `</span>`;
}

function renderSolarCards(windows, need) {
  const el = $("cards"), sum = $("solarSummary");
  const totalSolar = round1(windows.reduce((s, w) => s + w.kwh, 0));
  renderSavings(totalSolar, need);

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
    cum += w.kwh;
    const justReached = !reached && cum >= need;
    if (justReached) reached = true;
    const unsure = di >= 2 ? `<span class="badge unsure">Tag&nbsp;3 — unsicher</span>` : "";
    const reach = justReached ? `<span class="badge free">deckt deine ${need} kWh</span>` : "";
    return `<div class="card">
      <span class="badge free">quasi-gratis · Solar</span>${reach}${unsure}
      <div class="when">${fmtDay(w.start)}, ${fmtH(w.start)}–${fmtH(w.end)}</div>
      <div class="big">${w.avgKw}<small> kW ⌀ (bis ${w.peakKw} kW)</small></div>
      <div class="meta">${w.hours}&nbsp;h · ca. <b>${w.kwh}&nbsp;kWh</b> Solar · kumuliert ${round1(cum)}&nbsp;kWh</div>
    </div>`;
  }).join("");
}

function renderPvChart(hours) {
  const labels = hours.map(h => h.time);
  return new Chart($("pvChart"), {
    data: {
      labels,
      datasets: [
        { type: "bar", label: "solar-ladbar (kW)", data: hours.map(h => h.chargeable ? h.surplus : 0), backgroundColor: "#21a25b", stack: "s", order: 3, barPercentage: 1, categoryPercentage: 1 },
        { type: "bar", label: "Überschuss zu klein (kW)", data: hours.map(h => h.chargeable ? 0 : h.surplus), backgroundColor: "#e8a33d", stack: "s", order: 3, barPercentage: 1, categoryPercentage: 1 },
        { type: "line", label: "PV-Produktion (kW)", data: hours.map(h => h.pv), borderColor: "#c2880a", backgroundColor: "transparent", borderWidth: 2, pointRadius: 0, tension: .35, order: 1 },
        { type: "line", label: "Hausgrundlast (kW)", data: hours.map(() => CONFIG.baseLoadKw), borderColor: "#9aa7b5", borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, order: 2 }
      ]
    },
    options: timeOpts("kW")
  });
}

function renderPriceChart(prices, cheapWin) {
  if (!prices.length) {
    $("priceChart").parentElement.innerHTML =
      `<p class="hint">Aktuell keine Spotpreise verfügbar (Tagespreise erscheinen ~13:00 für morgen).</p>`;
    return null;
  }
  const colors = prices.map(p => (cheapWin && p.time >= cheapWin.start && p.time < cheapWin.end) ? "#2f6df0" : "#bcd0f7");
  return new Chart($("priceChart"), {
    type: "bar",
    data: { labels: prices.map(p => p.time), datasets: [
      { label: "Spotpreis (ct/kWh)", data: prices.map(p => round1(p.ct)), backgroundColor: colors, barPercentage: 1, categoryPercentage: .92 }
    ] },
    options: timeOpts("ct/kWh")
  });
}

function renderExaa(d) {
  const el = $("exaa");
  if (!el) return;
  if (!d) { el.hidden = true; return; }
  const hh = h => String(h).padStart(2, "0");
  el.hidden = false;
  el.innerHTML =
    `<span class="ex-title"><span class="ex-flag">AT</span> Offizielle österreichische Strombörse (EXAA) · Day-Ahead-Auktion</span>
     <span class="ex-val">Durchschnitt: <b>${round1(d.avg)} ct/kWh</b></span>
     <span class="ex-val">Günstigste Stunde: <b>${hh(d.min.hour)}–${hh(d.min.hour + 1)} Uhr</b> (${round1(d.min.ct)} ct)</span>
     <span class="ex-val">Teuerste: <b>${round1(d.max.ct)} ct</b></span>
     <span class="ex-note">Amtliche Day-Ahead-Auktion der Energy Exchange Austria für Liefertag ${d.day} (Marktgebiet AT) — als offizielle Referenz zum dynamischen Spotpreis darüber.</span>`;
}

function renderPriceCard(cheapWin, need) {
  const el = $("priceCards");
  if (!cheapWin) { el.innerHTML = ""; return; }
  const cost = (cheapWin.avg / 100) * need;
  const h = Math.round((cheapWin.end - cheapWin.start) / 3600e3);
  el.innerHTML = `<div class="card grid">
    <span class="badge cheap">günstigster Netzstrom</span>
    <div class="when">${fmtDay(cheapWin.start)}, ${fmtH(cheapWin.start)}–${fmtH(cheapWin.end)}</div>
    <div class="big">${round1(cheapWin.avg)}<small> ct/kWh ⌀</small></div>
    <div class="meta">${need}&nbsp;kWh laden ≈ <b>${cost.toFixed(2)}&nbsp;€</b> Energiekosten
    (ohne Netz/Steuern) — günstigstes ${h}-h-Fenster bei ${CONFIG.wallbox.maxKw}&nbsp;kW.</div>
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

/* ---------- Standort-Autocomplete (Open-Meteo Geocoding, keyless) ---------- */
let geoTimer = null;
function wireGeocoder() {
  const inp = $("place"), list = $("placeResults");
  inp.addEventListener("input", () => {
    clearTimeout(geoTimer);
    const q = inp.value.trim();
    if (q.length < 2) { list.hidden = true; return; }
    geoTimer = setTimeout(async () => {
      try {
        const u = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=de`;
        const j = await (await fetch(u)).json();
        const res = j.results || [];
        if (!res.length) { list.hidden = true; return; }
        list.innerHTML = res.map((r, i) =>
          `<div class="ac-item" data-i="${i}">
             <div class="ac-name">${r.name}</div>
             <div class="ac-sub">${[r.admin1, r.country].filter(Boolean).join(", ")}</div>
           </div>`).join("");
        list.hidden = false;
        list.querySelectorAll(".ac-item").forEach(it =>
          it.addEventListener("mousedown", e => { e.preventDefault(); pickPlace(res[+it.dataset.i]); }));
      } catch { list.hidden = true; }
    }, 250);
  });
  inp.addEventListener("blur", () => setTimeout(() => list.hidden = true, 150));
}
function pickPlace(r) {
  CONFIG.lat = r.latitude; CONFIG.lon = r.longitude; CONFIG.locName = r.name;
  $("place").value = [r.name, r.admin1].filter(Boolean).join(", ");
  $("placeResults").hidden = true;
  $("placeMeta").textContent = `${r.latitude.toFixed(3)}, ${r.longitude.toFixed(3)}`;
  $("subLoc").textContent = r.name;
  scheduleReloadPv();
}

/* ---------- Boot ---------- */
function aziLabel(a) {
  if (a <= -75) return "Ost";
  if (a < -15) return "Südost";
  if (a <= 15) return "Süd";
  if (a < 75) return "Südwest";
  return "West";
}
function showConfig() {
  $("config").innerHTML =
    `Wallbox <b>${CONFIG.wallbox.maxKw} kW</b> 3-phasig · ladbar ab ${CONFIG.wallbox.minKw} kW · ` +
    `Hausgrundlast ${CONFIG.baseLoadKw} kW · Systemwirkungsgrad ${String(CONFIG.pr).replace(".", ",")}`;
}

const STATE = { raw: [], prices: [], pvChart: null, priceChart: null };

// haengt nur von kWp/Bedarf/Tarif ab -> ohne neue API-Calls
function recompute() {
  const need = getNeedKwh();
  const hours = derive(STATE.raw);
  if (STATE.pvChart) STATE.pvChart.destroy();
  STATE.pvChart = renderPvChart(hours);
  renderSolarCards(buildSolarWindows(hours), need);

  if (STATE.prices.length) {
    const n = Math.max(1, Math.min(STATE.prices.length, Math.ceil(need / CONFIG.wallbox.maxKw)));
    const cheap = cheapestPriceWindow(STATE.prices, n);
    if (STATE.priceChart) STATE.priceChart.destroy();
    STATE.priceChart = renderPriceChart(STATE.prices, cheap);
    renderPriceCard(cheap, need);
  }
}

// PV neu laden, wenn Standort/Neigung/Ausrichtung sich aendern (GTI haengt davon ab)
let reloadTimer = null;
function scheduleReloadPv() {
  $("tiltVal").textContent = CONFIG.tilt + "°";
  $("aziVal").textContent = aziLabel(CONFIG.azimuth);
  const status = $("status");
  status.className = "status";
  status.textContent = `Aktualisiere PV-Prognose für ${CONFIG.locName} (${CONFIG.tilt}° ${aziLabel(CONFIG.azimuth)})…`;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    try {
      STATE.raw = await fetchPvRaw();
      TODAY0 = startOfDay(STATE.raw[0]?.time || new Date());
      recompute();
      status.className = "status hide";
    } catch (e) {
      status.className = "status error";
      status.textContent = "Fehler beim Aktualisieren: " + e.message;
    }
  }, 350);
}

async function main() {
  showConfig();
  wireGeocoder();
  const status = $("status");
  try {
    const [raw, prices] = await Promise.all([fetchPvRaw(), fetchPrices()]);
    TODAY0 = startOfDay(raw[0]?.time || new Date());
    STATE.raw = raw; STATE.prices = prices;
    recompute();
    status.classList.add("hide");

    // Offizielle AT-Boerse EXAA separat laden (nicht kritisch fuer die App)
    fetchExaa().then(renderExaa).catch(e => { console.warn("EXAA:", e.message); renderExaa(null); });

    // lokale Eingaben -> nur neu rechnen
    $("need").addEventListener("input", recompute);
    $("kwp").addEventListener("input", recompute);
    $("tariff").addEventListener("input", recompute);
    // Standort/Dach -> PV neu laden
    $("tilt").addEventListener("input", e => { CONFIG.tilt = +e.target.value; scheduleReloadPv(); });
    $("azi").addEventListener("input", e => { CONFIG.azimuth = +e.target.value; scheduleReloadPv(); });
  } catch (e) {
    status.textContent = "Fehler beim Laden der Daten: " + e.message;
    status.classList.add("error");
    console.error(e);
  }
}
main();

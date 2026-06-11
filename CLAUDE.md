# SunCharge — Solar-EV-Ladeberater

Client-seitige Single-Page-Web-App: empfiehlt für eine 10 kWp PV-Anlage in
Lanzenkirchen (47.70°N, 16.18°E), wann/mit wie viel kW man das E-Auto quasi-gratis
aus Solar-Überschuss laden kann (3 Tage), und wann sonst der Netzbezug am günstigsten
ist (dynamischer Spotpreis, heute+morgen).

## Datenquellen (gratis, kein Key, CORS-offen — Browser ruft direkt)
- **PV-Forecast:** Open-Meteo `forecast` mit `global_tilted_irradiance` (Modulebene).
- **Spotpreis:** aWATTar AT `marketdata`. EUR/MWh → ct/kWh = /10. Doku: `~/Data/energy-spotprice.md`.

## Modell
P_pv = GTI/1000 × kWp(10) × PR(0.85), max 10 kW. surplus = max(0, P_pv − Grundlast 0.5).
Solar-ladbar nur wenn surplus ≥ 4.1 kW (11 kW Wallbox, 3-phasig, Minimum 6 A).

## Ehrlichkeits-Prinzipien
- "quasi-gratis" statt "kostenlos" (entgangene Einspeisevergütung).
- Ladeleistung = kW, Energie = kWh.
- Tag 3 unsicher markiert; Spotpreise nur heute+morgen; nie erfundene Werte.

## Dateien
- `index.html` / `app.js` / `styles.css` — alles statisch, Chart.js via CDN.

## Deploy
Live auf **GitHub Pages**: https://nichtagentur.github.io/suncharge/
(Vercel war am Deploy-Tag am Free-Tier-Limit 100/Tag — Pages als Fallback,
statische Seite, `gh api .../pages`.) Update: `git push` → Pages baut automatisch.

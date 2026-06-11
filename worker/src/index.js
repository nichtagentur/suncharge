// SunCharge CORS-Proxy fuer offizielle oesterreichische Energiequellen.
// EXAA (Energy Exchange Austria, offizielle AT-Strompreisboerse) und APG
// (staatlicher Uebertragungsnetzbetreiber) liefern keine CORS-Header, also
// kann eine reine Browser-App sie nicht direkt laden. Dieser Worker holt die
// Daten serverseitig und gibt sie mit offenem CORS weiter.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

function json(body, status = 200, extra = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", ...extra },
  });
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    try {
      // Offizielle AT-Day-Ahead-Auktion (EXAA, 10:15-Auktion, Markt AT)
      if (url.pathname === "/exaa") {
        const day = url.searchParams.get("day") || new Date().toISOString().slice(0, 10);
        const r = await fetch(
          `https://www.exaa.at/data/market-results?delivery_day=${day}&market=AT&auction=1015`,
          { cf: { cacheTtl: 900 } }
        );
        return json(await r.text(), r.status, { "Cache-Control": "public, max-age=900" });
      }

      // APG Netz-Spitzenstunden-Signal (staatlicher Netzbetreiber)
      if (url.pathname === "/apg") {
        const r = await fetch("https://awareness.cloud.apg.at/api/v1/PeakHourStatus");
        return json(await r.text(), r.status, { "Cache-Control": "public, max-age=900" });
      }

      return json({ ok: true, routes: ["/exaa?day=YYYY-MM-DD", "/apg"] });
    } catch (e) {
      return json({ error: String(e) }, 502);
    }
  },
};

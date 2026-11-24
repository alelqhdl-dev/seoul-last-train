// Overpass(OSM) helper
const MIRRORS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export async function overpass(query, { timeoutMs = 180000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const m of MIRRORS) {
      try {
        const r = await fetch(m, {
          method: 'POST',
          headers: {
            'User-Agent': 'seoul-last-train-atlas/0.1 (personal project)',
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: 'data=' + encodeURIComponent(query),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!r.ok) throw new Error(`${m} HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        lastErr = e;
        console.warn('overpass fail:', e.message);
      }
    }
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
  }
  throw lastErr;
}

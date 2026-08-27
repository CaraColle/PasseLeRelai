/**
 * prefetch.js — Prefetch isochrones and nearby shops for French train stations.
 * Run: node prefetch.js
 * Requires: Node 18+ (uses the global fetch API).
 * Env: ORS_API_KEY — OpenRouteService API key for isochrone generation.
 */

'use strict';

// ---------------------------------------------------------------------------
// Station definitions
// ---------------------------------------------------------------------------
const stations = [
  { name: 'Gare de Lyon',                      lat: 48.8443, lng: 2.3743 },
  { name: 'Gare du Nord',                      lat: 48.8809, lng: 2.3553 },
  { name: 'Gare de l\'Est',                    lat: 48.8768, lng: 2.3590 },
  { name: 'Gare Montparnasse',                 lat: 48.8412, lng: 2.3210 },
  { name: 'Gare Saint-Lazare',                 lat: 48.8757, lng: 2.3244 },
  { name: 'Gare d\'Austerlitz',                lat: 48.8425, lng: 2.3648 },
  { name: 'Gare de Marseille-Saint-Charles',   lat: 43.3037, lng: 5.3806 },
  { name: 'Gare de Lyon-Part-Dieu',            lat: 45.7605, lng: 4.8592 },
  { name: 'Gare de Lyon-Perrache',             lat: 45.7488, lng: 4.8256 },
  { name: 'Gare de Toulouse-Matabiau',         lat: 43.6112, lng: 1.4535 },
  { name: 'Gare de Nice-Ville',                lat: 43.7047, lng: 7.2620 },
  { name: 'Gare de Nantes',                    lat: 47.2173, lng: -1.5416 },
  { name: 'Gare de Montpellier Saint-Roch',    lat: 43.6047, lng: 3.8807 },
  { name: 'Gare de Montpellier Sud de France', lat: 43.6157, lng: 3.9325 },
  { name: 'Gare de Strasbourg-Ville',          lat: 48.5851, lng: 7.7347 },
  { name: 'Gare de Bordeaux-Saint-Jean',       lat: 44.8256, lng: -0.5563 },
  { name: 'Gare de Lille-Flandres',            lat: 50.6365, lng: 3.0708 },
  { name: 'Gare de Lille-Europe',              lat: 50.6395, lng: 3.0755 },
  { name: 'Gare de Rennes',                    lat: 48.1032, lng: -1.6726 },
  { name: 'Gare de Reims',                     lat: 49.2600, lng: 4.0247 },
  { name: 'Gare du Havre',                     lat: 49.4938, lng: 0.1078 },
  { name: 'Gare de Saint-Étienne-Châteaucreux',lat: 45.4406, lng: 4.4025 },
  { name: 'Gare de Toulon',                    lat: 43.1247, lng: 5.9308 },
  { name: 'Gare de Grenoble',                  lat: 45.1913, lng: 5.7141 },
  { name: 'Gare de Dijon-Ville',               lat: 47.3227, lng: 5.0227 },
  { name: 'Gare d\'Angers-Saint-Laud',         lat: 47.4649, lng: -0.5567 },
  { name: 'Gare de Nîmes',                     lat: 43.8323, lng: 4.3616 },
  { name: 'Gare du Mans',                      lat: 47.9952, lng: 0.1921 },
  { name: 'Gare d\'Aix-en-Provence TGV',       lat: 43.4553, lng: 5.3172 },
  { name: 'Gare de Clermont-Ferrand',          lat: 45.7767, lng: 3.0952 },
  { name: 'Gare de Brest',                     lat: 48.3903, lng: -4.4835 },
  { name: 'Gare de Tours',                     lat: 47.3894, lng: 0.6939 },
  { name: 'Gare de Limoges-Bénédictins',       lat: 45.8339, lng: 1.2621 },
  { name: 'Gare d\'Amiens',                    lat: 49.8934, lng: 2.3057 },
  { name: 'Gare de Perpignan',                 lat: 42.6939, lng: 2.8895 },
  { name: 'Gare de Metz-Ville',                lat: 49.1099, lng: 6.1778 },
  { name: 'Gare de Besançon-Viotte',           lat: 47.2427, lng: 6.0242 },
  { name: 'Gare d\'Orléans',                   lat: 47.9078, lng: 1.9047 },
  { name: 'Gare de Mulhouse-Ville',            lat: 47.7403, lng: 7.3398 },
  { name: 'Gare de Rouen-Rive-Droite',         lat: 49.4431, lng: 1.0993 },
  { name: 'Gare de Caen',                      lat: 49.1839, lng: -0.3477 },
  { name: 'Gare de Nancy-Ville',               lat: 48.6900, lng: 6.1704 }
];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONCURRENCY = 4;           // number of stations processed in parallel
const OVERPASS_MIN_INTERVAL = 1200; // ms between Overpass calls (global throttle)

// ---------------------------------------------------------------------------
// Chain store detection
// ---------------------------------------------------------------------------
const CHAIN_KEYWORDS = [
  'carrefour', 'leclerc', 'auchan', 'intermarché', 'casino', 'monoprix',
  'franprix', 'match', 'simply', 'géant', 'super u', 'cora', 'hyper',
  'amazon', 'fnac', 'decathlon', 'leroy merlin', 'ikea', 'boulanger',
  'darty', 'cultura', 'maisons du monde', 'habitat',
  'zara', 'h&m', 'uniqlo', 'gap', 'mango', 'marks & spencer',
  'starbucks', 'mcdonald', 'burger king', 'kfc', 'subway', 'quick',
  'paul', 'pain quotidien', 'ladurée', 'pierre hermé',
  'pains & traditions', 'bouchon lyonnais',
  'bonne maman', 'leader price', 'prix mania', 'netto',
  'carrefour contact', 'carrefour express', 'carrefour city',
  'sainsbury', 'tesco', 'asda', 'morrisons',
];

function isChain(shop) {
  const name = (shop.tags?.name || '').toLowerCase();
  const brand = (shop.tags?.brand || '').toLowerCase();
  const operator = (shop.tags?.operator || '').toLowerCase();
  const combined = `${name} ${brand} ${operator}`;
  return CHAIN_KEYWORDS.some(keyword => combined.includes(keyword));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildShopQuery(station) {
  const lat = station.lat;
  const lng = station.lng;
  const delta = 0.015; // ~1.5km bounding box
  const bbox = `${lat - delta},${lng - delta},${lat + delta},${lng + delta}`;

  // Single combined regex query instead of 4 separate shop=X blocks —
  // fewer clauses = faster parse/execution on the Overpass server.
  return `[out:json][timeout:60];
(
  node["shop"~"^(kiosk|books|bakery|convenience)$"](${bbox});
  way["shop"~"^(kiosk|books|bakery|convenience)$"](${bbox});
);
out center tags;`;
}

// ---------------------------------------------------------------------------
// Overpass throttle (global, shared across concurrent station workers)
// ---------------------------------------------------------------------------
let overpassQueue = Promise.resolve();

function scheduleOverpassCall(fn) {
  const run = overpassQueue.then(async () => {
    const result = await fn();
    await sleep(OVERPASS_MIN_INTERVAL);
    return result;
  });
  // Prevent unhandled rejection from breaking the chain for subsequent callers
  overpassQueue = run.catch(() => {});
  return run;
}

/**
 * Retry logic with exponential backoff for Overpass API.
 * Tries the "preferred" mirror first (last one that worked), falls back to others.
 */
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];
let preferredMirrorIndex = 0;

async function overpassQueryRaw(query, retries = 3, delayMs = 2000) {
  let lastError;
  const orderedUrls = [
    OVERPASS_URLS[preferredMirrorIndex],
    ...OVERPASS_URLS.filter((_, i) => i !== preferredMirrorIndex),
  ];

  for (let attempt = 1; attempt <= retries; attempt++) {
    for (const url of orderedUrls) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

        const res = await fetch(url, {
          method: "POST",
          body: "data=" + encodeURIComponent(query),
          signal: controller.signal,
          headers: { "User-Agent": "passe-le-relai-prefetch/1.0" }
        });

        clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

        const data = await res.json();
        preferredMirrorIndex = OVERPASS_URLS.indexOf(url); // remember what worked
        return data;

      } catch (err) {
        lastError = err;
      }
    }

    if (attempt < retries) {
      const wait = delayMs * Math.pow(2, attempt - 1);
      await sleep(wait);
    }
  }

  throw lastError;
}

function overpassQuery(query) {
  return scheduleOverpassCall(() => overpassQueryRaw(query));
}

/** Fetch shops via Overpass API (throttled globally). */
async function fetchShops(station) {
  const query = buildShopQuery(station);
  const data = await overpassQuery(query);
  const independentShops = data.elements.filter(shop => !isChain(shop));
  return { ...data, elements: independentShops };
}

/**
 * Fetch isochrones via ORS API.
 * Only 5 and 10 minutes (300 and 600 seconds).
 * No artificial delay — ORS allows decent burst rates and runs in parallel
 * with Overpass calls, not serialized after them.
 */
async function fetchIsochrones(lat, lng) {
  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) throw new Error('ORS_API_KEY environment variable is not set');

  const body = {
    locations: [[lng, lat]],
    range: [300, 600],
    range_type: 'time',
    profile: 'foot-walking',
    units: 'm',
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch('https://api.openrouteservice.org/v2/isochrones/foot-walking', {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ORS API returned ${res.status}: ${text}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function writeJson(path, data) {
  const fs = await import('fs/promises');
  await fs.writeFile(path, JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Per-station processing
// ---------------------------------------------------------------------------
async function processStation(station, dataDir, timestamp) {
  const fs = await import('fs/promises');
  const slug = slugify(station.name);
  const outPath = `${dataDir}/${slug}.json`;

  console.log(`--- Station: ${station.name} (${slug}) — starting ---`);

  let existing = {};
  try {
    const raw = await fs.readFile(outPath, 'utf8');
    existing = JSON.parse(raw);
  } catch {
    // no existing file
  }

  // Fetch shops and isochrones CONCURRENTLY (independent APIs)
  const [shopsResult, isoResult] = await Promise.allSettled([
    fetchShops(station),
    fetchIsochrones(station.lat, station.lng),
  ]);

  let staleDataWarning = false;
  let shopsData, isochronesData;

  if (shopsResult.status === 'fulfilled') {
    shopsData = shopsResult.value;
    console.log(`  [${station.name}] Shops: ${shopsData.elements?.length ?? 0}`);
  } else {
    console.error(`  [WARN][${station.name}] Shops fetch failed: ${shopsResult.reason.message}`);
    staleDataWarning = true;
    shopsData = existing.shops ?? null;
  }

  if (isoResult.status === 'fulfilled') {
    isochronesData = isoResult.value;
    console.log(`  [${station.name}] Isochrones: ${isochronesData.features?.length ?? 0}`);
  } else {
    console.error(`  [WARN][${station.name}] Isochrones fetch failed: ${isoResult.reason.message}`);
    staleDataWarning = true;
    isochronesData = existing.isochrones ?? null;
  }

  const stationData = {
    station: { name: station.name, lat: station.lat, lng: station.lng },
    isochrones: isochronesData,
    shops: shopsData,
    fetchedAt: timestamp,
    staleDataWarning,
  };

  if (!isochronesData && !shopsData && Object.keys(existing).length > 0) {
    console.log(`  [WARN][${station.name}] No data fetched — keeping existing file untouched.`);
    return {
      name: station.name,
      slug,
      lat: station.lat,
      lng: station.lng,
      file: `data/stations/${slug}.json`,
      shopCount: existing.shops?.elements?.length ?? 0,
      fetchedAt: existing.fetchedAt ?? timestamp,
      staleDataWarning: true,
    };
  }

  await writeJson(outPath, stationData);
  console.log(`  [${station.name}] Written: ${outPath}`);

  return {
    name: station.name,
    slug,
    lat: station.lat,
    lng: station.lng,
    file: `data/stations/${slug}.json`,
    shopCount: shopsData?.elements?.length ?? 0,
    fetchedAt: timestamp,
    staleDataWarning,
  };
}

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------
async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, runWorker);
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const fs = await import('fs/promises');
  const dataDir = './data/stations';
  await fs.mkdir(dataDir, { recursive: true });

  const timestamp = new Date().toISOString();
  console.log(`\n=== Prefetch starting at ${timestamp} (concurrency=${CONCURRENCY}) ===\n`);

  const t0 = Date.now();

  const stationMeta = await runPool(
    stations,
    (station) => processStation(station, dataDir, timestamp),
    CONCURRENCY
  );

  const indexData = {
    generatedAt: timestamp,
    staleDataWarning: stationMeta.some(s => s.staleDataWarning),
    stations: stationMeta,
  };

  await writeJson('./data/stations-index.json', indexData);

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== Prefetch complete in ${elapsedSec}s. Index written to data/stations-index.json ===\n`);
}

main().catch(err => {
  console.error('\n[ERROR] Prefetch failed:', err.message);
  process.exit(1);
});

/**
 * prefetch.js — Prefetch isochrones and nearby shops for Paris train stations.
 * Run: node prefetch.js
 * Requires: Node 18+ (uses the global fetch API).
 * Env: ORS_API_KEY — OpenRouteService API key for isochrone generation.
 */

'use strict';

// ---------------------------------------------------------------------------
// Station definitions
// ---------------------------------------------------------------------------
const stations = [
  { name: 'Gare de Lyon',      lat: 48.8443, lng: 2.3735 },
  { name: 'Gare du Nord',      lat: 48.8809, lng: 2.3553 },
  { name: 'Gare Montparnasse', lat: 48.8414, lng: 2.3181 },
  { name: 'Gare Saint-Lazare', lat: 48.8768, lng: 2.3243 },
  { name: 'Gare de l\'Est',    lat: 48.8760, lng: 2.3597 },
  { name: 'Gare d\'Austerlitz',lat: 48.8418, lng: 2.3646 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a station name to a URL-safe slug.
 * "Gare de Lyon" → "gare-de-lyon"
 */
function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Pause for ms milliseconds. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build an Overpass QL query to find shops around a point.
 * Uses BBOX instead of polygon (simpler, less likely to fail).
 */
function buildShopQuery(station) {
  const lat = station.lat;
  const lng = station.lng;
  const delta = 0.015; // ~1.5km bounding box
  
  return `[out:json][timeout:90];
(
  node["shop"="kiosk"](${lat - delta},${lng - delta},${lat + delta},${lng + delta});
  way["shop"="kiosk"](${lat - delta},${lng - delta},${lat + delta},${lng + delta});
  node["shop"="books"](${lat - delta},${lng - delta},${lat + delta},${lng + delta});
  way["shop"="books"](${lat - delta},${lng - delta},${lat + delta},${lng + delta});
  node["shop"="bakery"](${lat - delta},${lng - delta},${lat + delta},${lng + delta});
  way["shop"="bakery"](${lat - delta},${lng - delta},${lat + delta},${lng + delta});
  node["shop"="convenience"](${lat - delta},${lng - delta},${lat + delta},${lng + delta});
  way["shop"="convenience"](${lat - delta},${lng - delta},${lat + delta},${lng + delta});
);
out center tags;`;
}

/**
 * Query Overpass with retry logic and multiple mirror URLs.
 * Tries each mirror up to `retries` times with exponential backoff.
 */
async function overpassQuery(query, retries = 5, delayMs = 3000) {
  const OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://z.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ];
  
  let lastError;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    for (const url of OVERPASS_URLS) {
      try {
        console.log(`    [Attempt ${attempt}/${retries}] Trying ${url.split('/')[2]}...`);
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 min timeout
        
        const res = await fetch(url, {
          method: "POST",
          body: "data=" + encodeURIComponent(query),
          signal: controller.signal,
          headers: { "User-Agent": "passe-le-relai-prefetch/1.0" }
        });
        
        clearTimeout(timeoutId);
        
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        
        const data = await res.json();
        console.log(`    ✓ Overpass returned ${data.elements?.length || 0} elements`);
        return data;
        
      } catch (err) {
        lastError = err;
        console.warn(`    ✗ ${url.split('/')[2]} failed: ${err.message}`);
      }
    }
    
    if (attempt < retries) {
      const wait = delayMs * Math.pow(2, attempt - 1);
      console.log(`    Waiting ${wait}ms before retry ${attempt + 1}/${retries}...`);
      await sleep(wait);
    }
  }
  
  throw lastError;
}

/** Fetch isochrones via ORS API (foot-walking, 300/600/900 seconds). */
async function fetchIsochrones(lat, lng) {
  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) throw new Error('ORS_API_KEY environment variable is not set');

  const body = {
    locations: [[lng, lat]],
    range: [300, 600, 900],
    range_type: 'time',
    profile: 'foot-walking',
    units: 'm',
  };

  const res = await fetch('https://api.openrouteservice.org/v2/isochrones/foot-walking', {
    method: 'POST',
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ORS API returned ${res.status}: ${text}`);
  }

  return res.json();
}

/** Write data to a JSON file atomically. */
async function writeJson(path, data) {
  const fs = await import('fs/promises');
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(path, content, 'utf8');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const fs = await import('fs/promises');
  const dataDir = './data/stations';

  // Ensure output directories exist
  await fs.mkdir(dataDir, { recursive: true });

  const stationMeta = [];
  const timestamp = new Date().toISOString();

  console.log(`\n=== Prefetch starting at ${timestamp} ===\n`);

  for (const station of stations) {
    const slug = slugify(station.name);
    const outPath = `${dataDir}/${slug}.json`;

    console.log(`\n📍 Station: ${station.name}`);

    let shopsData = null;
    let isochronesData = null;
    let staleDataWarning = false;

    // Try loading existing file for graceful failure
    let existing = {};
    try {
      const raw = await fs.readFile(outPath, 'utf8');
      existing = JSON.parse(raw);
    } catch {
      // No existing file — will be treated as fresh
    }

    // ============ FETCH ISOCHRONES ============
    try {
      console.log(`  Fetching isochrones from ORS...`);
      isochronesData = await fetchIsochrones(station.lat, station.lng);
      console.log(`  ✓ Isochrones fetched: ${isochronesData.features?.length ?? 0} features`);
    } catch (err) {
      console.error(`  ✗ Isochrones fetch failed: ${err.message}`);
      staleDataWarning = true;
      isochronesData = existing.isochrones ?? null;
    }

    // ============ FETCH SHOPS (WITH RETRY LOGIC) ============
    try {
      console.log(`  Fetching shops from Overpass...`);
      shopsData = await overpassQuery(buildShopQuery(station));
      console.log(`  ✓ Shops fetched: ${shopsData.elements?.length ?? 0} elements`);
    } catch (err) {
      console.error(`  ⚠ All Overpass attempts failed: ${err.message}`);
      console.error(`  Continuing without shops for this station...`);
      staleDataWarning = true;
      shopsData = existing.shops ?? null;
    }

    // ============ WRITE TO FILE ============
    const stationData = {
      station: {
        name: station.name,
        lat: station.lat,
        lng: station.lng,
      },
      isochrones: isochronesData,
      shops: shopsData,
      fetchedAt: timestamp,
      staleDataWarning,
    };

    // Keep existing data if both fetches failed
    if (!isochronesData && !shopsData && Object.keys(existing).length > 0) {
      console.log(`  [WARN] No data fetched — keeping existing file for ${slug}.json`);
      stationMeta.push({
        name: station.name,
        slug,
        lat: station.lat,
        lng: station.lng,
        file: `data/stations/${slug}.json`,
        shopCount: existing.shops?.elements?.length ?? 0,
        fetchedAt: existing.fetchedAt ?? timestamp,
        staleDataWarning: true,
      });
    } else {
      await writeJson(outPath, stationData);
      console.log(`  ✓ Written to ${outPath}`);

      stationMeta.push({
        name: station.name,
        slug,
        lat: station.lat,
        lng: station.lng,
        file: `data/stations/${slug}.json`,
        shopCount: shopsData?.elements?.length ?? 0,
        fetchedAt: timestamp,
        staleDataWarning,
      });
    }

    // ============ RATE LIMITING ============
    if (stations.indexOf(station) < stations.length - 1) {
      console.log(`  💤 Sleeping 8s before next station...`);
      await sleep(8000);
    }
  }

  // Write index
  const indexData = {
    generatedAt: timestamp,
    staleDataWarning: stationMeta.some(s => s.staleDataWarning),
    stations: stationMeta,
  };

  await writeJson('./data/stations-index.json', indexData);
  console.log(`\n=== Prefetch complete. Index written to data/stations-index.json ===\n`);
}

main().catch(err => {
  console.error('\n[ERROR] Prefetch failed:', err.message);
  process.exit(1);
});

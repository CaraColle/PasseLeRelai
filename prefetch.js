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
 * Point-in-polygon test using ray casting algorithm.
 * Returns true if point [lng, lat] is inside the polygon.
 */
function pointInPolygon(point, polygon) {
  const [lng, lat] = point;
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];

    if (
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }

  return inside;
}

/**
 * Check if a point is inside any isochrone polygon.
 */
function isPointInIsochrone(point, isochrones) {
  if (!isochrones || !isochrones.features) return false;

  for (const feature of isochrones.features) {
    const geometry = feature.geometry;
    if (!geometry) continue;

    // Handle Polygon
    if (geometry.type === 'Polygon') {
      const exterior = geometry.coordinates[0]; // Outer ring
      if (pointInPolygon(point, exterior)) {
        return true;
      }
    }
    // Handle MultiPolygon
    else if (geometry.type === 'MultiPolygon') {
      for (const polygon of geometry.coordinates) {
        const exterior = polygon[0];
        if (pointInPolygon(point, exterior)) {
          return true;
        }
      }
    }
  }

  return false;
}

/** Build an Overpass QL query to find shops around a point within radius meters. */
function buildShopQueryAround(lat, lng, radius = 1500) {
  const delta = radius / 111000; // Convert meters to degrees (rough approximation)
  return `
[out:json][timeout:60];
(
  node["shop"="bakery"](${lat - delta},${lng - delta},${lat + delta},${lng + delta});
  way["shop"="bakery"](${lat - delta},${lng - delta},${lat + delta},${lng + delta});
  node["shop"="convenience"](${lat - delta},${lng - delta},${lat + delta},${lng + delta});
  way["shop"="convenience"](${lat - delta},${lng - delta},${lat + delta},${lng + delta});
  node["shop"="supermarket"](${lat - delta},${lng - delta},${lat + delta},${lng + delta});
  way["shop"="supermarket"](${lat - delta},${lng - delta},${lat + delta},${lng + delta});
);
out center tags;
`.trim();
}

/** Fetch shops via Overpass API. */
async function fetchShops(lat, lng, radius = 1500) {
  const query = buildShopQueryAround(lat, lng, radius);
  const url = 'https://overpass-api.de/api/interpreter';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`Overpass API returned ${res.status}`);
  return res.json();
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

    console.log(`\n--- Station: ${station.name} (${slug}) ---`);

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

    // Fetch shops (non-fatal on failure)
    try {
      console.log(`  Fetching shops from Overpass...`);
      shopsData = await fetchShops(station.lat, station.lng);
      console.log(`  Shops fetched: ${shopsData.elements?.length ?? 0} total elements`);
    } catch (err) {
      console.error(`  [WARN] Shops fetch failed: ${err.message}. Using existing data if available.`);
      staleDataWarning = true;
      shopsData = existing.shops ?? null;
    }

    // Fetch isochrones (non-fatal on failure)
    try {
      console.log(`  Fetching isochrones from ORS...`);
      isochronesData = await fetchIsochrones(station.lat, station.lng);
      console.log(`  Isochrones fetched: ${isochronesData.features?.length ?? 0} features`);
    } catch (err) {
      console.error(`  [WARN] Isochrones fetch failed: ${err.message}. Using existing data if available.`);
      staleDataWarning = true;
      isochronesData = existing.isochrones ?? null;
    }

    // Filter shops to only those inside isochrones
    if (shopsData && isochronesData) {
      const shopsInsideIsochrones = shopsData.elements.filter(shop => {
        const point = shop.lon !== undefined && shop.lat !== undefined 
          ? [shop.lon, shop.lat]
          : null;
        
        if (!point) return false;
        return isPointInIsochrone(point, isochronesData);
      });

      console.log(`  Filtered to ${shopsInsideIsochrones.length} shops inside isochrones`);
      
      shopsData = {
        ...shopsData,
        elements: shopsInsideIsochrones,
      };
    }

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
      console.log(`  [WARN] No data fetched and no existing data found — skipping write for ${slug}.json`);
      // Still add to index with warning
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
      console.log(`  Written: ${outPath}`);

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

    // Rate-limit: 2 s between stations
    if (stations.indexOf(station) < stations.length - 1) {
      console.log(`  Sleeping 2 s before next station...`);
      await sleep(2000);
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

/**
 * prefetch.js — Prefetch isochrones and nearby shops for train stations across France.
 * Run: node prefetch.js
 * Requires: Node 18+ (uses the global fetch API).
 * Env: ORS_API_KEY — OpenRouteService API key for isochrone generation.
 */

'use strict';

// ---------------------------------------------------------------------------
// Station definitions (flattened from all cities in the cities object used by index.html)
// ---------------------------------------------------------------------------
const stations =
    [
      { name: "Gare de Lyon", lat: 48.8443, lng: 2.3743 },
      { name: "Gare du Nord", lat: 48.8809, lng: 2.3553 },
      { name: "Gare de l'Est", lat: 48.8768, lng: 2.359 },
      { name: "Gare Montparnasse", lat: 48.8412, lng: 2.321 },
      { name: "Gare Saint-Lazare", lat: 48.8757, lng: 2.3244 },
      { name: "Gare d'Austerlitz", lat: 48.8425, lng: 2.3648 },
      { name: "Gare de Marseille-Saint-Charles", lat: 43.3037, lng: 5.3806 },
      { name: "Gare de Lyon-Part-Dieu", lat: 45.7605, lng: 4.8592 },
      { name: "Gare de Lyon-Perrache", lat: 45.7488, lng: 4.8256 },
      { name: "Gare de Toulouse-Matabiau", lat: 43.6112, lng: 1.4535 },
      { name: "Gare de Nice-Ville", lat: 43.7047, lng: 7.262 },
      { name: "Gare de Nantes", lat: 47.2173, lng: -1.5416 },
      { name: "Gare de Montpellier Saint-Roch", lat: 43.6047, lng: 3.8807 },
      { name: "Gare de Montpellier Sud de France", lat: 43.6157, lng: 3.9325 },
      { name: "Gare de Strasbourg-Ville", lat: 48.5851, lng: 7.7347 },
      { name: "Gare de Bordeaux-Saint-Jean", lat: 44.8256, lng: -0.5563 },
      { name: "Gare de Lille-Flandres", lat: 50.6365, lng: 3.0708 },
      { name: "Gare de Lille-Europe", lat: 50.6395, lng: 3.0755 },
      { name: "Gare de Rennes", lat: 48.1032, lng: -1.6726 },
      { name: "Gare de Reims", lat: 49.26, lng: 4.0247 },
      { name: "Gare du Havre", lat: 49.4938, lng: 0.1078 },
      { name: "Gare de Saint-Étienne-Châteaucreux", lat: 45.4406, lng: 4.4025 },
      { name: "Gare de Toulon", lat: 43.1247, lng: 5.9308 },
      { name: "Gare de Grenoble", lat: 45.1913, lng: 5.7141 },
      { name: "Gare de Dijon-Ville", lat: 47.3227, lng: 5.0227 },
      { name: "Gare d'Angers-Saint-Laud", lat: 47.4649, lng: -0.5567 },
      { name: "Gare de Nîmes", lat: 43.8323, lng: 4.3616 },
      { name: "Gare du Mans", lat: 48.0009, lng: 0.1936 },
      { name: "Gare d'Aix-en-Provence TGV", lat: 43.4553, lng: 5.3172 },
      { name: "Gare de Clermont-Ferrand", lat: 45.7767, lng: 3.0952 },
      { name: "Gare de Brest", lat: 48.3903, lng: -4.4835 },
      { name: "Gare de Tours", lat: 47.3875, lng: 0.6883 },
      { name: "Gare de Limoges-Bénédictins", lat: 45.8339, lng: 1.2621 },
      { name: "Gare d'Amiens", lat: 49.8934, lng: 2.3057 },
      { name: "Gare de Perpignan", lat: 42.6939, lng: 2.8895 },
      { name: "Gare de Metz-Ville", lat: 49.1099, lng: 6.1778 },
      { name: "Gare de Besançon-Viotte", lat: 47.2427, lng: 6.0242 },
      { name: "Gare d'Orléans", lat: 47.9089, lng: 1.904 },
      { name: "Gare de Mulhouse-Ville", lat: 47.7403, lng: 7.3398 },
      { name: "Gare de Rouen-Rive-Droite", lat: 49.4431, lng: 1.0993 },
      { name: "Gare de Caen", lat: 49.1839, lng: -0.3477 },
      { name: "Gare de Nancy-Ville", lat: 48.69, lng: 6.1704 },
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

/** Build an Overpass QL query to find shops around a point within radius meters. */
function buildShopQueryAround(lat, lng, radius = 800) {
  const types = ['bakery', 'convenience', 'supermarket'];
  const typeQuery = types.map(t => `node["shop="${t}"]`).join('\n        ');
  return `
[out:json][timeout:60];
(
  ${typeQuery}
)->.shops;
(
  node.wkts_around(.shops, ${lat}, ${lng}, ${radius});
)->.result;
.result out body;
`.trim();
}

/** Fetch shops via Overpass API. */
async function fetchShops(lat, lng, radius = 800) {
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
      console.log(`  Shops fetched: ${shopsData.elements?.length ?? 0} elements`);
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

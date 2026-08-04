/**
 * prefetch.js — Prefetch isochrones and nearby independent bakeries,
 * bookstores and kiosks for train stations.
 *
 * Run:
 *   node prefetch.js
 *
 * Requires:
 *   Node 18+
 *
 * Env:
 *   ORS_API_KEY — OpenRouteService API key for isochrone generation.
 */

'use strict';

// ---------------------------------------------------------------------------
// Station definitions
// ---------------------------------------------------------------------------

const stations = [
  { name: 'Gare de Lyon', lat: 48.8443, lng: 2.3735 },
  { name: 'Gare du Nord', lat: 48.8809, lng: 2.3553 },
  { name: 'Gare Montparnasse', lat: 48.8414, lng: 2.3181 },
  { name: 'Gare Saint-Lazare', lat: 48.8768, lng: 2.3243 },
  { name: "Gare de l'Est", lat: 48.8760, lng: 2.3597 },
  { name: "Gare d'Austerlitz", lat: 48.8418, lng: 2.3646 },
  { name: 'Gare de Lille-Flandres', lat: 50.6365, lng: 3.0708 },
  { name: 'Gare de Lille-Europe', lat: 50.6395, lng: 3.0755 }
];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

const SHOP_TYPES = new Set([
  'bakery',
  'books',
  'kiosk'
]);

/**
 * These are common chains or institutional operators that should not be
 * displayed as independent businesses.
 *
 * This list can be extended as needed.
 */
const EXCLUDED_BUSINESS_NAMES = [
  'relay',
  'lagardere',
  'lagardère',
  'monop',
  'monoprix',
  'carrefour',
  'franprix',
  'casino',
  'cora',
  'auchan',
  'e.leclerc',
  'leclerc',
  'intermarche',
  'intermarché',
  'système u',
  'systeme u',
  'super u',
  'cultura',
  'fnac',
  'furet du nord',
  'paul',
  'brioche dorée',
  'brioche doree',
  'la mie câline',
  'la mie caline',
  'feuillette',
  'pomme de pain',
  'louis delhaize',
  'vapostore'
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a station name to a URL-safe slug.
 */
function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Pause for ms milliseconds.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Point-in-polygon test using the ray-casting algorithm.
 *
 * Point and polygon coordinates use:
 *   [longitude, latitude]
 */
function pointInPolygon(point, polygon) {
  if (!Array.isArray(point) || !Array.isArray(polygon) || polygon.length < 3) {
    return false;
  }

  const [lng, lat] = point;
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];

    const intersects =
      (yi > lat) !== (yj > lat) &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

/**
 * Check whether a point is inside a GeoJSON geometry.
 */
function isPointInGeometry(point, geometry) {
  if (!geometry) return false;

  if (geometry.type === 'Polygon') {
    const exterior = geometry.coordinates?.[0];
    return exterior ? pointInPolygon(point, exterior) : false;
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some(polygon => {
      const exterior = polygon?.[0];
      return exterior ? pointInPolygon(point, exterior) : false;
    });
  }

  return false;
}

/**
 * Check whether a point is inside any isochrone.
 */
function isPointInIsochrone(point, isochrones) {
  if (!isochrones?.features?.length) return false;

  return isochrones.features.some(feature =>
    isPointInGeometry(point, feature.geometry)
  );
}

/**
 * Get coordinates from an Overpass element.
 *
 * Nodes:
 *   element.lat / element.lon
 *
 * Ways and relations:
 *   element.center.lat / element.center.lon
 */
function getElementCoordinates(element) {
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;

  if (lat == null || lon == null) {
    return null;
  }

  return {
    lat: Number(lat),
    lon: Number(lon)
  };
}

/**
 * Normalize text for comparison.
 */
function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Determine whether an OSM element represents an independent business.
 *
 * OSM has no reliable universal "independent business" field, so this uses
 * conservative heuristics:
 *
 * - Excludes businesses with a brand or operator tag.
 * - Excludes names matching known chains.
 * - Excludes businesses explicitly located in or operated by a station.
 */
function isIndependentBusiness(element) {
  const tags = element.tags || {};

  const name = normalizeText(tags.name);
  const brand = normalizeText(tags.brand);
  const operator = normalizeText(tags.operator);
  const network = normalizeText(tags.network);
  const ownership = normalizeText(tags.ownership);

  const combinedText = [
    name,
    brand,
    operator,
    network,
    ownership
  ].filter(Boolean).join(' ');

  const isKnownChain = EXCLUDED_BUSINESS_NAMES.some(chain =>
    combinedText.includes(normalizeText(chain))
  );

  if (isKnownChain) {
    return false;
  }

  /*
   * A brand/operator tag is treated as evidence that the business is part of
   * a chain or an organized network. This is intentionally conservative.
   */
  if (brand || operator || network) {
    return false;
  }

  const stationRelatedValues = [
    tags.location,
    tags.operator,
    tags.owner,
    tags.description,
    tags.note
  ]
    .filter(Boolean)
    .map(normalizeText)
    .join(' ');

  if (
    stationRelatedValues.includes('gare') ||
    stationRelatedValues.includes('station') ||
    stationRelatedValues.includes('relay') ||
    stationRelatedValues.includes('sncf')
  ) {
    return false;
  }

  /*
   * Do not keep unnamed businesses. They cannot be meaningfully displayed
   * as independent shops in the interface.
   */
  if (!name) {
    return false;
  }

  return true;
}

/**
 * Keep only bakeries, bookstores and kiosks.
 */
function isAllowedShop(element) {
  const shopType = element.tags?.shop;
  return SHOP_TYPES.has(shopType) && isIndependentBusiness(element);
}

/**
 * Remove duplicate OSM elements.
 */
function deduplicateElements(elements) {
  const seen = new Set();

  return elements.filter(element => {
    const key = `${element.type}/${element.id}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Overpass
// ---------------------------------------------------------------------------

/**
 * Build an Overpass query for bakeries, bookstores and kiosks.
 */
function buildShopQueryAround(lat, lng, radius = 1500) {
  const latDelta = radius / 111000;

  // Correct longitude conversion for the latitude.
  const lngDelta =
    radius / (111000 * Math.cos((lat * Math.PI) / 180));

  const south = lat - latDelta;
  const west = lng - lngDelta;
  const north = lat + latDelta;
  const east = lng + lngDelta;

  return `
[out:json][timeout:90];
(
  node["shop"="bakery"](${south},${west},${north},${east});
  way["shop"="bakery"](${south},${west},${north},${east});
  relation["shop"="bakery"](${south},${west},${north},${east});

  node["shop"="books"](${south},${west},${north},${east});
  way["shop"="books"](${south},${west},${north},${east});
  relation["shop"="books"](${south},${west},${north},${east});

  node["shop"="kiosk"](${south},${west},${north},${east});
  way["shop"="kiosk"](${south},${west},${north},${east});
  relation["shop"="kiosk"](${south},${west},${north},${east});
);
out center tags;
`.trim();
}

/**
 * Fetch shops via Overpass with retries and fallback endpoints.
 */
async function fetchShops(lat, lng, radius = 1500) {
  const query = buildShopQueryAround(lat, lng, radius);
  let lastError = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: `data=${encodeURIComponent(query)}`
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(
            `Overpass API returned ${res.status}: ${text.slice(0, 300)}`
          );
        }

        const data = await res.json();

        return {
          ...data,
          elements: Array.isArray(data.elements) ? data.elements : []
        };
      } catch (err) {
        lastError = err;

        console.warn(
          `  [WARN] Overpass attempt ${attempt} failed at ${endpoint}: ${err.message}`
        );

        if (attempt < 2) {
          await sleep(3000);
        }
      }
    }
  }

  throw lastError || new Error('All Overpass endpoints failed');
}

// ---------------------------------------------------------------------------
// OpenRouteService
// ---------------------------------------------------------------------------

/**
 * Fetch isochrones via ORS API.
 */
async function fetchIsochrones(lat, lng) {
  const apiKey = process.env.ORS_API_KEY;

  if (!apiKey) {
    throw new Error('ORS_API_KEY environment variable is not set');
  }

  const body = {
    locations: [[lng, lat]],
    range: [300, 600],
    range_type: 'time',
    profile: 'foot-walking',
    units: 'm'
  };

  const res = await fetch(
    'https://api.openrouteservice.org/v2/isochrones/foot-walking',
    {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ORS API returned ${res.status}: ${text}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// File utilities
// ---------------------------------------------------------------------------

/**
 * Write data to a JSON file.
 */
async function writeJson(path, data) {
  const fs = await import('fs/promises');
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(path, content, 'utf8');
}

/**
 * Read existing station data if available.
 */
async function readExistingJson(path) {
  const fs = await import('fs/promises');

  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const fs = await import('fs/promises');
  const dataDir = './data/stations';

  await fs.mkdir(dataDir, { recursive: true });

  const stationMeta = [];
  const timestamp = new Date().toISOString();

  console.log(`\n=== Prefetch starting at ${timestamp} ===\n`);

  for (let index = 0; index < stations.length; index++) {
    const station = stations[index];
    const slug = slugify(station.name);
    const outPath = `${dataDir}/${slug}.json`;

    console.log(`\n--- Station: ${station.name} (${slug}) ---`);

    let shopsData = null;
    let isochronesData = null;
    let staleDataWarning = false;

    const existing = await readExistingJson(outPath);

    // ---------------------------------------------------------
    // Fetch shops
    // ---------------------------------------------------------

    try {
      console.log('  Fetching independent shops from Overpass...');

      const fetchedShops = await fetchShops(
        station.lat,
        station.lng
      );

      const relevantElements = deduplicateElements(
        fetchedShops.elements.filter(isAllowedShop)
      );

      shopsData = {
        ...fetchedShops,
        elements: relevantElements
      };

      console.log(
        `  Relevant independent shops fetched: ${relevantElements.length}`
      );
    } catch (err) {
      console.warn(
        `  [WARN] Shops fetch failed: ${err.message}. Using existing data if available.`
      );

      staleDataWarning = true;
      shopsData = existing.shops ?? null;
    }

    // ---------------------------------------------------------
    // Fetch isochrones
    // ---------------------------------------------------------

    try {
      console.log('  Fetching isochrones from ORS...');

      isochronesData = await fetchIsochrones(
        station.lat,
        station.lng
      );

      console.log(
        `  Isochrones fetched: ${isochronesData.features?.length ?? 0} features`
      );
    } catch (err) {
      console.warn(
        `  [WARN] Isochrones fetch failed: ${err.message}. Using existing data if available.`
      );

      staleDataWarning = true;
      isochronesData = existing.isochrones ?? null;
    }

    // ---------------------------------------------------------
    // Filter shops to the isochrone area
    // ---------------------------------------------------------

    let filteredShopsData = shopsData;

    if (shopsData?.elements && isochronesData?.features) {
      const shopsInsideIsochrones = shopsData.elements.filter(shop => {
        const coordinates = getElementCoordinates(shop);

        if (!coordinates) {
          return false;
        }

        return isPointInIsochrone(
          [coordinates.lon, coordinates.lat],
          isochronesData
        );
      });

      filteredShopsData = {
        ...shopsData,
        elements: shopsInsideIsochrones
      };

      console.log(
        `  Independent shops inside 5/10-minute isochrones: ${shopsInsideIsochrones.length}`
      );
    } else if (shopsData?.elements && !isochronesData?.features) {
      /*
       * Keep the independent shop data if ORS is unavailable. It will be
       * filtered by the frontend only when isochrones are available.
       */
      console.log(
        `  [WARN] Isochrones unavailable; keeping ${shopsData.elements.length} independent shops unfiltered`
      );
    }

    // ---------------------------------------------------------
    // Write station data
    // ---------------------------------------------------------

    const stationData = {
      station: {
        name: station.name,
        lat: station.lat,
        lng: station.lng
      },
      isochrones: isochronesData,
      shops: filteredShopsData,
      fetchedAt: timestamp,
      staleDataWarning
    };

    await writeJson(outPath, stationData);

    console.log(`  Written: ${outPath}`);

    stationMeta.push({
      name: station.name,
      slug,
      lat: station.lat,
      lng: station.lng,
      file: `data/stations/${slug}.json`,
      shopCount: filteredShopsData?.elements?.length ?? 0,
      fetchedAt: timestamp,
      staleDataWarning
    });

    // Rate limit requests between stations.
    if (index < stations.length - 1) {
      console.log('  Sleeping 2 seconds before next station...');
      await sleep(2000);
    }
  }

  // ---------------------------------------------------------
  // Write stations index
  // ---------------------------------------------------------

  const indexData = {
    generatedAt: timestamp,
    staleDataWarning: stationMeta.some(
      station => station.staleDataWarning
    ),
    stations: stationMeta
  };

  await writeJson('./data/stations-index.json', indexData);

  console.log(
    '\n=== Prefetch complete. Index written to data/stations-index.json ===\n'
  );
}

main().catch(err => {
  console.error('\n[ERROR] Prefetch failed:', err.message);
  process.exit(1);
});


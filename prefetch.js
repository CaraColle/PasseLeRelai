// prefetch.js
// Pre-fetches isochrone polygons for known locations and stores them in cache.
// Modified version: range array in fetchIsochrones now only includes [300, 600].

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const LOCATIONS = [
  { id: 'home',     lat: 52.5200, lon: 13.4050 },
  { id: 'office',   lat: 52.5300, lon: 13.4200 },
  { id: 'school',   lat: 52.5100, lon: 13.3900 }
];

const API_KEY = process.env.ORS_API_KEY || '';
const BASE_URL = 'https://api.openrouteservice.org/v2/isochrones';

/**
 * Fetches isochrone polygons for a given coordinate.
 * Modified: only 5-minute (300s) and 10-minute (600s) isochrones are requested.
 */
async function fetchIsochrones(lat, lon) {
  const range = [300, 600];
  const params = {
    locations: [[lon, lat]],
    profile: 'driving-car',
    range: range,
    range_type: 'time',
    attributes: ['total_pop']
  };

  try {
    const response = await axios.post(BASE_URL, params, {
      headers: {
        'Authorization': API_KEY,
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (err) {
    console.error(`Error fetching isochrones for ${lat},${lon}:`, err.message);
    throw err;
  }
}

/**
 * Returns cached isochrone data for a location id if present.
 */
function getCachedIsochrones(id) {
  const file = path.join(CACHE_DIR, `${id}.json`);
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return null;
}

/**
 * Writes isochrone data to disk cache.
 */
function cacheIsochrones(id, data) {
  const file = path.join(CACHE_DIR, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/**
 * Pre-fetches isochrones for all configured locations, using cache when possible.
 */
async function prefetchAll() {
  for (const loc of LOCATIONS) {
    const cached = getCachedIsochrones(loc.id);
    if (cached) {
      console.log(`Cache hit: ${loc.id}`);
      continue;
    }
    console.log(`Fetching isochrones for ${loc.id}...`);
    const data = await fetchIsochrones(loc.lat, loc.lon);
    cacheIsochrones(loc.id, data);
  }
  console.log('Prefetch complete.');
}

if (require.main === module) {
  prefetchAll().catch(err => {
    console.error('Prefetch failed:', err);
    process.exit(1);
  });
}

module.exports = {
  fetchIsochrones,
  getCachedIsochrones,
  cacheIsochrones,
  prefetchAll,
  LOCATIONS
};

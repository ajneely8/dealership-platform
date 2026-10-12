import { and, count, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { dealerships, prospects } from "@/db/schema";
import { dedupeKeys, findDuplicateInDb } from "@/domain/dedupe";
import { emit } from "@/lib/agent-events";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { nameFromDomain, normalizeDomain, normalizeWebsite } from "@/lib/normalize";
import { getSettings } from "@/lib/settings";
import { enqueue } from "@/queue";
import { chatLauncherVisible } from "./interaction/chat-probe";
import { relayFinish, relayHolding, relayStart } from "./relay";
import { Crawler } from "./website/crawler";
import { classifyForms, detectChat, findLinks, LEAD_FORM_TYPES } from "./website/detect";

/**
 * Prospecting: find dealerships on our own, screen each one, and admit only those the agents
 * can actually research.
 *
 * Source: OpenStreetMap (Overpass API) — public map data of car dealers with a website tag,
 * nearest to the configured centre first. Nothing is scraped from a brand's dealer locator.
 *
 * Screen (one homepage visit, presented as a visitor): the site must be readable (no block,
 * no robots refusal, no CAPTCHA), must show the signals research needs (inventory and a way
 * to make contact: a lead form or a contact page), and if it runs a chat widget the launcher
 * must actually appear. Anything else is REJECTED with the reason and never becomes a
 * dealership. Admitted sites become dealerships and go straight into research.
 */

/** Public Overpass mirrors, tried in turn; each is rate-limited, so a failure on one is routine. */
const OVERPASS_MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://lz4.overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
let mirrorIndex = 0;

async function overpass(query: string): Promise<{ elements: Osm[] }> {
  let lastError = "";
  for (let i = 0; i < OVERPASS_MIRRORS.length; i++) {
    const url = OVERPASS_MIRRORS[(mirrorIndex + i) % OVERPASS_MIRRORS.length]!;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 40_000);
    try {
      const res = await fetch(url, { method: "POST", body: `data=${encodeURIComponent(query)}`, headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "DealerIntelResearch/0.1 (prospecting; contact via the app operator)" }, signal: ctrl.signal });
      if (res.status === 429 || res.status === 504 || res.status === 503) {
        lastError = `${url} answered ${res.status}`;
        continue;
      }
      if (!res.ok) throw new Error(`${url} answered ${res.status}`);
      const data = (await res.json()) as { elements: Osm[] };
      mirrorIndex = (mirrorIndex + i) % OVERPASS_MIRRORS.length; // stick with the mirror that worked
      return data;
    } catch (err) {
      lastError = `${url}: ${(err as Error).name === "AbortError" ? "timed out after 40 s" : (err as Error).message}`;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`every OpenStreetMap mirror failed — last: ${lastError}`);
}
/** Metro areas across the United States, visited in turn when prospecting is nationwide. */
const US_METROS: { name: string; lat: number; lng: number }[] = [
  { name: "San Antonio, TX", lat: 29.4241, lng: -98.4936 },
  { name: "Phoenix, AZ", lat: 33.4484, lng: -112.074 },
  { name: "Atlanta, GA", lat: 33.749, lng: -84.388 },
  { name: "Columbus, OH", lat: 39.9612, lng: -82.9988 },
  { name: "Denver, CO", lat: 39.7392, lng: -104.9903 },
  { name: "Charlotte, NC", lat: 35.2271, lng: -80.8431 },
  { name: "Kansas City, MO", lat: 39.0997, lng: -94.5786 },
  { name: "Orlando, FL", lat: 28.5383, lng: -81.3792 },
  { name: "Indianapolis, IN", lat: 39.7684, lng: -86.1581 },
  { name: "Nashville, TN", lat: 36.1627, lng: -86.7816 },
  { name: "Oklahoma City, OK", lat: 35.4676, lng: -97.5164 },
  { name: "Salt Lake City, UT", lat: 40.7608, lng: -111.891 },
  { name: "Sacramento, CA", lat: 38.5816, lng: -121.4944 },
  { name: "Portland, OR", lat: 45.5152, lng: -122.6784 },
  { name: "Pittsburgh, PA", lat: 40.4406, lng: -79.9959 },
  { name: "Minneapolis, MN", lat: 44.9778, lng: -93.265 },
  { name: "Richmond, VA", lat: 37.5407, lng: -77.436 },
  { name: "Little Rock, AR", lat: 34.7465, lng: -92.2896 },
  { name: "Boise, ID", lat: 43.615, lng: -116.2023 },
  { name: "Milwaukee, WI", lat: 43.0389, lng: -87.9065 },
  { name: "Louisville, KY", lat: 38.2527, lng: -85.7585 },
  { name: "Albuquerque, NM", lat: 35.0844, lng: -106.6504 },
  { name: "Birmingham, AL", lat: 33.5186, lng: -86.8104 },
  { name: "Dallas, TX", lat: 32.7767, lng: -96.797 },
  { name: "Houston, TX", lat: 29.7604, lng: -95.3698 },
  { name: "Tampa, FL", lat: 27.9506, lng: -82.4572 },
  { name: "St. Louis, MO", lat: 38.627, lng: -90.1994 },
  { name: "Omaha, NE", lat: 41.2565, lng: -95.9345 },
  { name: "Raleigh, NC", lat: 35.7796, lng: -78.6382 },
  { name: "Las Vegas, NV", lat: 36.1699, lng: -115.1398 },
  { name: "Tucson, AZ", lat: 32.2226, lng: -110.9747 },
  { name: "Jacksonville, FL", lat: 30.3322, lng: -81.6557 },
  { name: "Cleveland, OH", lat: 41.4993, lng: -81.6944 },
  { name: "Baltimore, MD", lat: 39.2904, lng: -76.6122 },
  { name: "Spokane, WA", lat: 47.6588, lng: -117.426 },
  { name: "Des Moines, IA", lat: 41.5868, lng: -93.625 },
  { name: "El Paso, TX", lat: 31.7619, lng: -106.485 },
  { name: "Lubbock, TX", lat: 33.5779, lng: -101.8552 },
  { name: "Corpus Christi, TX", lat: 27.8006, lng: -97.3964 },
  { name: "Shreveport, LA", lat: 32.5252, lng: -93.7502 },
  { name: "Jackson, MS", lat: 32.2988, lng: -90.1848 },
  { name: "Mobile, AL", lat: 30.6954, lng: -88.0399 },
  { name: "Chattanooga, TN", lat: 35.0456, lng: -85.3097 },
  { name: "Knoxville, TN", lat: 35.9606, lng: -83.9207 },
  { name: "Lexington, KY", lat: 38.0406, lng: -84.5037 },
  { name: "Dayton, OH", lat: 39.7589, lng: -84.1916 },
  { name: "Toledo, OH", lat: 41.6528, lng: -83.5379 },
  { name: "Grand Rapids, MI", lat: 42.9634, lng: -85.6681 },
  { name: "Fort Wayne, IN", lat: 41.0793, lng: -85.1394 },
  { name: "Peoria, IL", lat: 40.6936, lng: -89.589 },
  { name: "Madison, WI", lat: 43.0731, lng: -89.4012 },
  { name: "Sioux Falls, SD", lat: 43.5446, lng: -96.7311 },
  { name: "Fargo, ND", lat: 46.8772, lng: -96.7898 },
  { name: "Billings, MT", lat: 45.7833, lng: -108.5007 },
  { name: "Colorado Springs, CO", lat: 38.8339, lng: -104.8214 },
  { name: "Reno, NV", lat: 39.5296, lng: -119.8138 },
  { name: "Fresno, CA", lat: 36.7378, lng: -119.7871 },
  { name: "Bakersfield, CA", lat: 35.3733, lng: -119.0187 },
  { name: "Eugene, OR", lat: 44.0521, lng: -123.0868 },
  { name: "Tacoma, WA", lat: 47.2529, lng: -122.4443 },
  { name: "Harrisburg, PA", lat: 40.2732, lng: -76.8867 },
  { name: "Syracuse, NY", lat: 43.0481, lng: -76.1474 },
  { name: "Hartford, CT", lat: 41.7658, lng: -72.6734 },
  { name: "Providence, RI", lat: 41.824, lng: -71.4128 },
  { name: "Manchester, NH", lat: 42.9956, lng: -71.4548 },
  { name: "Greenville, SC", lat: 34.8526, lng: -82.394 },
  { name: "Savannah, GA", lat: 32.0809, lng: -81.0912 },
  { name: "Tallahassee, FL", lat: 30.4383, lng: -84.2807 },
  { name: "Wichita, KS", lat: 37.6872, lng: -97.3301 },
  { name: "Springfield, MO", lat: 37.2089, lng: -93.2923 },
  { name: "Tulsa, OK", lat: 36.154, lng: -95.9928 },
  { name: "Baton Rouge, LA", lat: 30.4515, lng: -91.1871 },
  // Second ring: mid-size and smaller metros, so the rotation keeps finding rooftops the big cities already gave up.
  { name: "Austin, TX", lat: 30.2672, lng: -97.7431 },
  { name: "Fort Worth, TX", lat: 32.7555, lng: -97.3308 },
  { name: "McAllen, TX", lat: 26.2034, lng: -98.23 },
  { name: "Amarillo, TX", lat: 35.222, lng: -101.8313 },
  { name: "Tyler, TX", lat: 32.3513, lng: -95.3011 },
  { name: "Waco, TX", lat: 31.5493, lng: -97.1467 },
  { name: "Midland, TX", lat: 31.9973, lng: -102.0779 },
  { name: "Laredo, TX", lat: 27.5306, lng: -99.4803 },
  { name: "Miami, FL", lat: 25.7617, lng: -80.1918 },
  { name: "Fort Myers, FL", lat: 26.6406, lng: -81.8723 },
  { name: "Tallahassee, FL", lat: 30.4383, lng: -84.2807 },
  { name: "Pensacola, FL", lat: 30.4213, lng: -87.2169 },
  { name: "Daytona Beach, FL", lat: 29.2108, lng: -81.0228 },
  { name: "Savannah, GA", lat: 32.0809, lng: -81.0912 },
  { name: "Macon, GA", lat: 32.8407, lng: -83.6324 },
  { name: "Columbia, SC", lat: 34.0007, lng: -81.0348 },
  { name: "Charleston, SC", lat: 32.7765, lng: -79.9311 },
  { name: "Wilmington, NC", lat: 34.2257, lng: -77.9447 },
  { name: "Asheville, NC", lat: 35.5951, lng: -82.5515 },
  { name: "Roanoke, VA", lat: 37.271, lng: -79.9414 },
  { name: "Norfolk, VA", lat: 36.8508, lng: -76.2859 },
  { name: "Huntsville, AL", lat: 34.7304, lng: -86.5861 },
  { name: "Montgomery, AL", lat: 32.3668, lng: -86.3 },
  { name: "Memphis, TN", lat: 35.1495, lng: -90.049 },
  { name: "Gulfport, MS", lat: 30.3674, lng: -89.0928 },
  { name: "Lafayette, LA", lat: 30.2241, lng: -92.0198 },
  { name: "Fayetteville, AR", lat: 36.0626, lng: -94.1574 },
  { name: "Fort Smith, AR", lat: 35.3859, lng: -94.3985 },
  { name: "Cincinnati, OH", lat: 39.1031, lng: -84.512 },
  { name: "Akron, OH", lat: 41.0814, lng: -81.519 },
  { name: "Detroit, MI", lat: 42.3314, lng: -83.0458 },
  { name: "Lansing, MI", lat: 42.7325, lng: -84.5555 },
  { name: "Flint, MI", lat: 43.0125, lng: -83.6875 },
  { name: "Chicago, IL", lat: 41.8781, lng: -87.6298 },
  { name: "Rockford, IL", lat: 42.2711, lng: -89.094 },
  { name: "Springfield, IL", lat: 39.7817, lng: -89.6501 },
  { name: "Evansville, IN", lat: 37.9716, lng: -87.5711 },
  { name: "South Bend, IN", lat: 41.6764, lng: -86.252 },
  { name: "Green Bay, WI", lat: 44.5133, lng: -88.0133 },
  { name: "Duluth, MN", lat: 46.7867, lng: -92.1005 },
  { name: "Rochester, MN", lat: 44.0121, lng: -92.4802 },
  { name: "Cedar Rapids, IA", lat: 41.9779, lng: -91.6656 },
  { name: "Davenport, IA", lat: 41.5236, lng: -90.5776 },
  { name: "Lincoln, NE", lat: 40.8136, lng: -96.7026 },
  { name: "Topeka, KS", lat: 39.0473, lng: -95.675 },
  { name: "Columbia, MO", lat: 38.9517, lng: -92.3341 },
  { name: "Joplin, MO", lat: 37.0842, lng: -94.5133 },
  { name: "Rapid City, SD", lat: 44.0805, lng: -103.231 },
  { name: "Bismarck, ND", lat: 46.8083, lng: -100.7837 },
  { name: "Cheyenne, WY", lat: 41.14, lng: -104.8202 },
  { name: "Casper, WY", lat: 42.8666, lng: -106.3131 },
  { name: "Missoula, MT", lat: 46.8721, lng: -113.994 },
  { name: "Great Falls, MT", lat: 47.5002, lng: -111.3008 },
  { name: "Idaho Falls, ID", lat: 43.4917, lng: -112.0339 },
  { name: "Provo, UT", lat: 40.2338, lng: -111.6585 },
  { name: "St. George, UT", lat: 37.0965, lng: -113.5684 },
  { name: "Grand Junction, CO", lat: 39.0639, lng: -108.5506 },
  { name: "Pueblo, CO", lat: 38.2544, lng: -104.6091 },
  { name: "Santa Fe, NM", lat: 35.687, lng: -105.9378 },
  { name: "Las Cruces, NM", lat: 32.3199, lng: -106.7637 },
  { name: "Flagstaff, AZ", lat: 35.1983, lng: -111.6513 },
  { name: "Yuma, AZ", lat: 32.6927, lng: -114.6277 },
  { name: "Los Angeles, CA", lat: 34.0522, lng: -118.2437 },
  { name: "San Diego, CA", lat: 32.7157, lng: -117.1611 },
  { name: "Riverside, CA", lat: 33.9806, lng: -117.3755 },
  { name: "San Jose, CA", lat: 37.3382, lng: -121.8863 },
  { name: "Oakland, CA", lat: 37.8044, lng: -122.2712 },
  { name: "Stockton, CA", lat: 37.9577, lng: -121.2908 },
  { name: "Redding, CA", lat: 40.5865, lng: -122.3917 },
  { name: "Santa Rosa, CA", lat: 38.4404, lng: -122.7141 },
  { name: "San Luis Obispo, CA", lat: 35.2828, lng: -120.6596 },
  { name: "Seattle, WA", lat: 47.6062, lng: -122.3321 },
  { name: "Yakima, WA", lat: 46.6021, lng: -120.5059 },
  { name: "Bend, OR", lat: 44.0582, lng: -121.3153 },
  { name: "Medford, OR", lat: 42.3265, lng: -122.8756 },
  { name: "Anchorage, AK", lat: 61.2181, lng: -149.9003 },
  { name: "Honolulu, HI", lat: 21.3069, lng: -157.8583 },
  { name: "Philadelphia, PA", lat: 39.9526, lng: -75.1652 },
  { name: "Allentown, PA", lat: 40.6084, lng: -75.4902 },
  { name: "Scranton, PA", lat: 41.4089, lng: -75.6624 },
  { name: "Erie, PA", lat: 42.1292, lng: -80.0851 },
  { name: "Buffalo, NY", lat: 42.8864, lng: -78.8784 },
  { name: "Rochester, NY", lat: 43.1566, lng: -77.6088 },
  { name: "Albany, NY", lat: 42.6526, lng: -73.7562 },
  { name: "Long Island, NY", lat: 40.7891, lng: -73.1349 },
  { name: "Newark, NJ", lat: 40.7357, lng: -74.1724 },
  { name: "Trenton, NJ", lat: 40.2171, lng: -74.7429 },
  { name: "Boston, MA", lat: 42.3601, lng: -71.0589 },
  { name: "Springfield, MA", lat: 42.1015, lng: -72.5898 },
  { name: "Worcester, MA", lat: 42.2626, lng: -71.8023 },
  { name: "Portland, ME", lat: 43.6591, lng: -70.2568 },
  { name: "Burlington, VT", lat: 44.4759, lng: -73.2121 },
  { name: "Wilmington, DE", lat: 39.7391, lng: -75.5398 },
  { name: "Washington, DC", lat: 38.9072, lng: -77.0369 },
  { name: "Charleston, WV", lat: 38.3498, lng: -81.6326 },
  { name: "Morgantown, WV", lat: 39.6295, lng: -79.9559 },
];
/** Metros in a row that gave nothing new; after a full lap the radius grows. */
let emptyStreak = 0;
let metroIndex = 0;
/**
 * Franchise (manufacturer-branded) stores are not targets: the product is for independent,
 * small-to-medium dealerships. Matched against the OSM brand tag, the name and the domain.
 */
export const FRANCHISE = /\b(ford|lincoln|chevrolet|chevy|gmc|buick|cadillac|chrysler|jeep|dodge|ram|cdjr|fiat|alfa romeo|maserati|toyota|lexus|honda|acura|nissan|infiniti|hyundai|genesis|kia|mazda|subaru|mitsubishi|volkswagen|vw|audi|bmw|mini|mercedes|benz|porsche|volvo|jaguar|land rover|range rover|tesla|rivian|lucid|polestar|scion|saturn|pontiac|oldsmobile|isuzu|suzuki)\b/i;
const FRANCHISE_DOMAIN = /ford|lincoln|chevrolet|chevy|gmc|buick|cadillac|chrysler|jeep|dodge|cdjr|toyota|lexus|honda|acura|nissan|infiniti|hyundai|genesis|kia(?![a-z])|mazda|subaru|mitsubishi|volkswagen|audi|bmw|mercedes|porsche|volvo|jaguar|landrover/i;
/** Not car dealers at all, even though the map tags them shop=car. */
const NOT_A_CAR_DEALER = /\brvs?\b|motorhome|camper|motorcycle|harley|powersports|\batv\b|boat|marine|trailer|golf cart|\bsemi\b|truck center|tractor|equipment/i;
/** Is this candidate a manufacturer franchise store? */
export function isFranchise(c: { name: string; domain?: string | null; brand?: string | null }): boolean {
  if (c.brand && c.brand.trim()) return true;
  if (FRANCHISE.test(c.name)) return true;
  if (c.domain && FRANCHISE_DOMAIN.test(c.domain)) return true;
  return false;
}
/** United States only (continental box; Alaska and Hawaii are outside the search radius anyway). */
const CA_PROVINCE = /^(ON|QC|BC|AB|MB|SK|NS|NB|NL|PE|NT|YT|NU|Ontario|Quebec|British Columbia|Alberta|Manitoba|Saskatchewan|Nova Scotia|New Brunswick|Newfoundland|Prince Edward Island)\b/i;
const CA_POSTCODE = /\b[A-CEGHJ-NPRSTVXY]\d[A-Z] ?\d[A-Z]\d\b/i;

function inUnitedStates(lat: number | null, lng: number | null, country: string | undefined, tags: Record<string, string> = {}): boolean {
  if (country && !/^(us|usa|united states)$/i.test(country.trim())) return false;
  // Southern Ontario and parts of BC sit inside the rough US box below; the address gives them away.
  if (CA_PROVINCE.test(tags["addr:state"] ?? "") || CA_PROVINCE.test(tags["addr:province"] ?? "") || CA_POSTCODE.test(tags["addr:postcode"] ?? "")) return false;
  if (lat === null || lng === null) return !!country;
  return lat >= 24.3 && lat <= 49.5 && lng >= -125 && lng <= -66.5;
}

/** National chains and non-dealer car businesses that are never prospects. */
const NATIONAL_CHAINS = /carmax|carvana|autonation|drivetime|vroom|shift.com|enterprise|hertz|avis|budget|copart|iaa[i.]|tesla|rivian|lucid|echopark|byrider|lithia|sonic|group1|penske/i;
const MIN_RADIUS_KM = 40;
const MAX_RADIUS_KM = 520;
let lastFetchAt = 0;
let radiusKm = 0;

type Osm = { id: number; type: string; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> };

function km(aLat: number, aLng: number, bLat: number, bLng: number) {
  const r = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

/** Pulls car dealers with a website from OpenStreetMap around the configured centre. Returns how many new candidates were stored. */
export async function refreshCandidates(): Promise<{ found: number; added: number; radiusKm: number; metro: string }> {
  const s = await getSettings();
  if (!radiusKm) radiusKm = Math.max(MIN_RADIUS_KM, s.prospectRadiusKm);
  // Nationwide: a different metro each time the pool runs dry, so the list is not one city.
  const metro = s.prospectNationwide ? US_METROS[metroIndex++ % US_METROS.length]! : { name: "configured centre", lat: s.prospectCenterLat, lng: s.prospectCenterLng };
  // Restricted to the United States area in OpenStreetMap, so a metro near the border (Detroit, Buffalo, Seattle) never pulls in Canada.
  const q = `[out:json][timeout:25];area["ISO3166-1"="US"]["admin_level"="2"]->.us;nwr["shop"="car"]["website"](area.us)(around:${Math.round(radiusKm * 1000)},${metro.lat},${metro.lng});out center tags 900;`;
  lastFetchAt = Date.now(); // set before the call so a failing mirror is not hammered every tick
  const data = await overpass(q);
  const existing = new Set((await db().select({ d: prospects.normalizedDomain }).from(prospects)).map((r) => r.d).concat((await db().select({ d: dealerships.normalizedDomain }).from(dealerships)).map((r) => r.d)).filter(Boolean) as string[]);
  let added = 0;
  for (const el of data.elements) {
    const tags = el.tags ?? {};
    const website = normalizeWebsite(tags.website ?? tags["contact:website"] ?? "");
    const domain = normalizeDomain(website);
    if (!website || !domain || existing.has(domain)) continue;
    // Skip the obvious non-dealers that carry shop=car (rental counters, parts shops) and the
    // national chains: the product is for independently run rooftops, not CarMax or Carvana.
    const name = (tags.name ?? nameFromDomain(website) ?? "").trim();
    if (!name || /rent|parts only|salvage|junk|u-?haul/i.test(name)) continue;
    if (NATIONAL_CHAINS.test(domain) || NATIONAL_CHAINS.test(name)) continue;
    if (isFranchise({ name, domain, brand: tags.brand ?? tags["brand:wikidata"] })) continue;
    if (/\.(mx|ca)$/i.test(domain)) continue;
    if (NOT_A_CAR_DEALER.test(name) || NOT_A_CAR_DEALER.test(domain)) continue;
    const lat = el.lat ?? el.center?.lat ?? null;
    const lng = el.lon ?? el.center?.lon ?? null;
    if (!inUnitedStates(lat, lng, tags["addr:country"], tags)) continue;
    existing.add(domain);
    await db().insert(prospects).values({
      source: "OSM",
      externalId: `${el.type}/${el.id}`,
      name,
      website,
      normalizedDomain: domain,
      phone: tags.phone ?? tags["contact:phone"] ?? null,
      city: tags["addr:city"] ?? null,
      state: tags["addr:state"] ?? null,
      latitude: lat,
      longitude: lng,
      distanceKm: lat !== null && lng !== null ? km(metro.lat, metro.lng, lat, lng) : null,
      status: "NEW",
    });
    added += 1;
  }
  const result = { found: data.elements.length, added, radiusKm, metro: metro.name };
  await emit(added ? `Found ${added} new independent dealership candidate(s) near ${metro.name}` : `No new independent candidates near ${metro.name}; moving on`, { agent: "nova", detail: `OpenStreetMap: ${data.elements.length} car dealers with a website within ${Math.round(radiusKm)} km; franchise stores, national chains and non-US entries skipped`, kind: "finding.created", status: added ? "DONE" : "INFO" });
  if (added === 0) {
    emptyStreak += 1;
    // Three metros in a row with nothing new, or a single centre that ran dry: look further out.
    if (!s.prospectNationwide || emptyStreak >= 3) {
      radiusKm = Math.min(MAX_RADIUS_KM, radiusKm + 80);
      emptyStreak = 0;
      await emit(`Widening the search to ${Math.round(radiusKm)} km around each metro`, { agent: "nova", kind: "finding.created" });
    }
  } else {
    emptyStreak = 0;
  }
  return result;
}

/** Puts every in-progress screening back in line (or turns franchise ones away). Used after a restart. */
const INTERRUPTED_ONCE = "screening was interrupted once; back in line";

/** Turns a candidate away from outside its screening job (used when the job itself was cut off). */
export async function rejectProspect(prospectId: string, reason: string): Promise<void> {
  const [p] = await db().select({ name: prospects.name, website: prospects.website, status: prospects.status }).from(prospects).where(eq(prospects.id, prospectId)).limit(1);
  if (!p || p.status === "ADMITTED" || p.status === "REJECTED") return;
  await db().update(prospects).set({ status: "REJECTED", reason, screenedAt: new Date() }).where(eq(prospects.id, prospectId));
  await emit(`Rejected ${p.name}: ${reason}`, { agent: "nova", detail: p.website ?? undefined, status: "BLOCKED", kind: "task.blocked" });
  await audit("system:prospecting", "prospect.rejected", "prospect", prospectId, { reason, website: p.website });
}

export async function unstickScreenings(): Promise<number> {
  const rows = await db().select().from(prospects).where(eq(prospects.status, "SCREENING"));
  for (const st of rows) {
    const franchise = isFranchise({ name: st.name, domain: st.normalizedDomain });
    await db().update(prospects).set(franchise ? { status: "REJECTED", reason: "a manufacturer franchise store — not a target", screenedAt: new Date() } : { status: "NEW", screenedAt: null }).where(eq(prospects.id, st.id));
  }
  return rows.length;
}

/** Every N seconds: top up the candidate pool if needed and send the nearest NEW candidate for screening. */
export async function prospectTick(): Promise<{ queued: boolean; reason?: string }> {
  const s = await getSettings();
  if (!s.prospectingEnabled) return { queued: false, reason: "prospecting is off" };
  // One dealership at a time: while another agent still has the baton, Nova waits.
  const relay = await relayHolding();
  if (relay) return { queued: false, reason: `waiting for the relay: ${relay.name} is with ${relay.stage}` };
  // A screening that started more than four minutes ago was interrupted (a restart); put the
  // candidate back in line — or turn it away outright if it is a franchise store.
  const stale = await db().select().from(prospects).where(and(eq(prospects.status, "SCREENING"), or(isNull(prospects.screenedAt), sql`${prospects.screenedAt} < now() - interval '4 minutes'`)));
  for (const st of stale) {
    const franchise = isFranchise({ name: st.name, domain: st.normalizedDomain });
    const again = st.reason === INTERRUPTED_ONCE;
    const update = franchise
      ? { status: "REJECTED" as const, reason: "a manufacturer franchise store — not a target", screenedAt: new Date() }
      : again
        ? { status: "REJECTED" as const, reason: "screening was cut short twice — the site is too slow or unstable to research", screenedAt: new Date() }
        : { status: "NEW" as const, reason: INTERRUPTED_ONCE, screenedAt: null };
    await db().update(prospects).set(update).where(eq(prospects.id, st.id));
    await emit(`Screening of ${st.name} was interrupted; ${franchise ? "turned away (franchise store)" : again ? "turned away (second time)" : "back in line"}`, { agent: "nova", detail: st.website ?? undefined, status: update.status === "REJECTED" ? "BLOCKED" : "INFO", kind: update.status === "REJECTED" ? "task.blocked" : "task.step.completed" });
  }
  const [screening] = await db().select({ n: count() }).from(prospects).where(eq(prospects.status, "SCREENING"));
  if (Number(screening?.n ?? 0) >= 2) return { queued: false, reason: "two screenings already running" };
  const [poolRow] = await db().select({ n: count() }).from(prospects).where(eq(prospects.status, "NEW"));
  const pool = Number(poolRow?.n ?? 0);
  let [next] = await db().select().from(prospects).where(eq(prospects.status, "NEW")).orderBy(sql`${prospects.distanceKm} asc nulls last`).limit(1);
  if (pool < 8 && Date.now() - lastFetchAt > 60_000) {
    try {
      await refreshCandidates();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "prospect refresh failed");
      await emit("OpenStreetMap did not answer; trying again in a minute", { agent: "nova", detail: (err as Error).message, status: "ERROR" });
      return { queued: false, reason: "source unavailable" };
    }
    [next] = await db().select().from(prospects).where(eq(prospects.status, "NEW")).orderBy(sql`${prospects.distanceKm} asc nulls last`).limit(1);
  }
  if (!next) return { queued: false, reason: "no candidates" };
  const r = await enqueue("prospect", { prospectId: next.id, manual: true });
  if (r.queued) await emit(`Screening next candidate: ${next.name}`, { agent: "orion", detail: next.website ?? undefined, kind: "task.created" });
  return { queued: r.queued, reason: r.reason };
}

/** The screening job: one visit, a decision, and either a new dealership or a recorded rejection. */
export async function runProspectScreen(prospectId: string): Promise<string> {
  const [p] = await db().select().from(prospects).where(eq(prospects.id, prospectId)).limit(1);
  if (!p) return "SKIPPED: prospect no longer exists";
  if (p.status !== "NEW") return `SKIPPED: already ${p.status.toLowerCase()}`;
  await db().update(prospects).set({ status: "SCREENING", screenedAt: new Date() }).where(eq(prospects.id, p.id));
  await emit(`Screening ${p.name}`, { detail: p.website ?? undefined });

  const reject = async (reason: string) => {
    await db().update(prospects).set({ status: "REJECTED", reason, screenedAt: new Date() }).where(eq(prospects.id, p.id));
    await emit(`Rejected ${p.name}: ${reason}`, { detail: p.website ?? undefined, status: "BLOCKED", kind: "task.blocked" });
    await audit("system:prospecting", "prospect.rejected", "prospect", p.id, { reason, website: p.website });
    return `REJECTED: ${reason}`;
  };

  if (!p.website) return reject("no website on record");
  if (isFranchise({ name: p.name, domain: p.normalizedDomain })) return reject("a manufacturer franchise store — not a target");
  // The readability check uses the same browser presentation every later scan uses, so a site is
  // admitted only if research will actually be able to read it.
  const crawler = await Crawler.open({ maxPages: 4, present: (await getSettings()).researchPresentation });
  try {
    const visit = await crawler.visit(p.website, "HOMEPAGE");
    if (!visit.snapshot) {
      const o = visit.page.outcome as string;
      return reject(o === "BLOCKED" ? "the website blocks automated visitors" : o === "ROBOTS_DISALLOWED" ? "robots.txt asks automated visitors to stay out" : o === "UNREACHABLE" ? `the website could not be reached (${visit.page.detail ?? "no detail"})` : `the homepage could not be read (${visit.page.detail ?? o})`);
    }
    const snap = visit.snapshot;
    if (snap.hasCaptcha) return reject("the website is behind a CAPTCHA");
    if (snap.title && FRANCHISE.test(snap.title) && /dealer|dealership/i.test(snap.title)) return reject(`a manufacturer franchise store ("${snap.title.slice(0, 60)}")`);
    const chat = detectChat([snap]);
    const forms = classifyForms(snap, "HOMEPAGE").filter((f) => LEAD_FORM_TYPES.includes(f.type));
    const links = findLinks(snap);
    const hasInventory = (links.INVENTORY?.length ?? 0) > 0;
    const hasContact = forms.length > 0 || (links.CONTACT?.length ?? 0) > 0;
    const hasCareers = (links.CAREERS?.length ?? 0) > 0;
    let launcher: string | null = null;
    if (chat.present) {
      // Chat vendors often withhold the widget from a headless browser; Charlie's tests present as a
      // visitor, so the launcher check does too (a second, separate browser).
      const probe = await Crawler.open({ maxPages: 1, present: "visitor" });
      try {
        const v2 = await probe.visit(p.website, "HOMEPAGE");
        launcher = v2.snapshot ? await chatLauncherVisible(probe.page, 12_000) : null;
      } finally {
        await probe.close();
      }
      await emit(launcher ? `Chat widget reachable: ${chat.vendor ?? "unknown vendor"} ("${launcher}")` : `Chat widget script present (${chat.vendor ?? "unknown vendor"}) but no launcher appeared`, { detail: p.website, status: launcher ? "DONE" : "BLOCKED", kind: "finding.created" });
    } else {
      await emit("No chat widget on the homepage", { detail: p.website, kind: "finding.created" });
    }
    await emit(`Signals: ${hasInventory ? "inventory" : "no inventory link"} · ${forms.length} lead form(s)${hasContact && forms.length === 0 ? " · contact page" : ""} · ${hasCareers ? "careers page" : "no careers page"}`, { detail: p.website, kind: "finding.created", status: "DONE" });

    if (!hasInventory) return reject("no inventory section was found on the website");
    if (!hasContact) return reject("no lead form or contact page was found");
    if (chat.present && !launcher) return reject(`the ${chat.vendor ?? "chat"} widget never showed a launcher, so the chatbot cannot be looked at`);
    // The four steps a full scan needs must all read cleanly: homepage (done), inventory, service, chat (done).
    const inv = await crawler.visit(links.INVENTORY![0]!, "INVENTORY");
    if (!inv.snapshot) return reject(`the inventory page could not be read (${inv.page.outcome}${inv.page.detail ? `: ${inv.page.detail}` : ""})`);
    await emit("Inventory page reads cleanly", { detail: inv.snapshot.url, kind: "finding.created", status: "DONE" });
    if (links.SERVICE?.[0]) {
      const svc = await crawler.visit(links.SERVICE[0], "SERVICE");
      if (!svc.snapshot) return reject(`the service page could not be read (${svc.page.outcome}${svc.page.detail ? `: ${svc.page.detail}` : ""})`);
      await emit("Service page reads cleanly", { detail: svc.snapshot.url, kind: "finding.created", status: "DONE" });
    } else {
      await emit("No service page linked from the homepage (allowed)", { detail: p.website, kind: "finding.created" });
    }

    // Admit: create the dealership (guarding against duplicates) and start its research.
    const keys = dedupeKeys({ name: p.name, website: p.website, phone: p.phone ?? undefined });
    const dup = await findDuplicateInDb({ name: p.name, website: p.website, phone: p.phone ?? undefined });
    if (dup) {
      await db().update(prospects).set({ status: "REJECTED", reason: "already on file", screenedAt: new Date(), dealershipId: dup.id }).where(eq(prospects.id, p.id));
      return "SKIPPED: already on file";
    }
    const settings = await getSettings();
    const [d] = await db()
      .insert(dealerships)
      .values({
        name: p.name,
        normalizedName: keys.normalizedName,
        website: p.website,
        normalizedDomain: keys.normalizedDomain,
        phone: p.phone,
        normalizedPhone: keys.normalizedPhone,
        city: p.city,
        state: keys.state ?? p.state,
        latitude: p.latitude,
        longitude: p.longitude,
        brands: [],
        testingApproved: false,
      })
      .returning({ id: dealerships.id });
    if (!d) throw new Error("could not create the dealership");
    await db().update(prospects).set({ status: "ADMITTED", screenedAt: new Date(), dealershipId: d.id, reason: `${chat.present ? `chat ${chat.vendor ?? "present"} reachable` : "no chat widget"} · ${forms.length} form(s) · inventory${hasCareers ? " · careers" : ""}` }).where(eq(prospects.id, p.id));
    await audit("system:prospecting", "prospect.admitted", "dealership", d.id, { prospectId: p.id, website: p.website });
    await emit(`Admitted ${p.name} — the relay starts: Nova reads the site, then Charlie calls and tests the chat, then Sage, Hunter, Atlas and Blaze`, { dealershipId: d.id, detail: `${p.website}${chat.present && launcher ? ` · chat ${chat.vendor ?? "widget"} ("${launcher}")` : ""}`, status: "DONE", kind: "finding.created" });
    // One dealership at a time: the baton is Nova's until the website is read, and Nova screens
    // nobody else until Blaze hands it back (see workers/relay.ts).
    await relayStart(d.id, p.name);
    await enqueue("discovery", { dealershipId: d.id, manual: settings.prospectingAroundTheClock });
    return `OK: admitted ${p.name}`;
  } finally {
    await crawler.close();
  }
}

/**
 * Safety net: a dealership admitted by prospecting whose first full scan is blocked is not
 * researchable after all. Remove it again and record why, so nothing untestable stays on file.
 * Dealerships added by hand are never touched.
 */
export async function demoteIfUnresearchable(dealershipId: string, scanResult: string, explicitReason?: string): Promise<boolean> {
  if (!explicitReason && !/^(BLOCKED|ROBOTS_DISALLOWED|UNREACHABLE)/.test(scanResult)) return false;
  const [p] = await db().select().from(prospects).where(and(eq(prospects.dealershipId, dealershipId), eq(prospects.status, "ADMITTED"))).limit(1);
  if (!p) return false;
  const reason = explicitReason ?? (/^BLOCKED/.test(scanResult) ? "the website blocks automated research" : /^ROBOTS/.test(scanResult) ? "robots.txt asks automated visitors to stay out" : "the website could not be reached");
  await db().update(prospects).set({ status: "REJECTED", reason: explicitReason ? reason : `${reason} (found on the first full scan)`, screenedAt: new Date(), dealershipId: null }).where(eq(prospects.id, p.id));
  await db().delete(dealerships).where(eq(dealerships.id, dealershipId));
  await audit("system:prospecting", "prospect.rejected", "prospect", p.id, { reason, scanResult: scanResult.slice(0, 200), removedDealershipId: dealershipId });
  await emit(`Removed ${p.name}: ${reason}`, { agent: "nova", detail: p.website ?? undefined, status: "BLOCKED", kind: "task.blocked" });
  await relayFinish(dealershipId, "nova", "removed — not researchable");
  return true;
}

// Read-only views (stats, recent, pool) live in lib/prospect-data so pages never load this module.
export { candidatePool, prospectStats, recentProspects } from "@/lib/prospect-data";

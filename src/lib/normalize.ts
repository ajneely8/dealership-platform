/** Normalisation used for duplicate detection and suppression matching. Pure functions only. */

export function normalizeWebsite(input: string | null | undefined): string | null {
  const raw = input?.trim();
  if (!raw) return null;
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withProto);
    if (!u.hostname.includes(".") && u.hostname !== "localhost") return null;
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** "https://WWW.Northside-Ford.com/inventory?x=1" -> "northside-ford.com". Port kept only for localhost fixtures. */
export function normalizeDomain(input: string | null | undefined): string | null {
  const site = normalizeWebsite(input);
  if (!site) return null;
  const u = new URL(site);
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const isLocal = host === "localhost" || host === "127.0.0.1";
  return isLocal && u.port ? `${host}:${u.port}` : host;
}

/** US-centric: returns 10 digits, or null when the input is not a plausible phone number. */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let digits = input.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length === 10 ? digits : null;
}

const STREET_ABBREVIATIONS: Record<string, string> = {
  street: "st",
  avenue: "ave",
  boulevard: "blvd",
  drive: "dr",
  road: "rd",
  highway: "hwy",
  parkway: "pkwy",
  lane: "ln",
  court: "ct",
  place: "pl",
  freeway: "fwy",
  expressway: "expy",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
  suite: "ste",
  interstate: "i",
};

export function normalizeAddress(input: string | null | undefined): string | null {
  if (!input) return null;
  const out = input
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\bi-(\d+)/g, "i $1")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => STREET_ABBREVIATIONS[w] ?? w)
    .join(" ");
  return out || null;
}

const NAME_NOISE = new Set(["inc", "llc", "ltd", "co", "corp", "company", "the", "of"]);

export function normalizeName(input: string): string {
  return input
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !NAME_NOISE.has(w))
    .join(" ");
}

export function normalizeState(input: string | null | undefined): string | null {
  const s = input?.trim().toUpperCase();
  return s ? s : null;
}

/** "stoepelford.com" -> "Stoepelford" — a stand-in until the site's own name is read. */
export function nameFromDomain(website: string | null | undefined): string | null {
  const domain = normalizeDomain(website);
  if (!domain) return null;
  const label = domain.split(":")[0]!.split(".").slice(0, -1).join(".") || domain;
  return label
    .split(/[.-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** True when a stored name is just the placeholder derived from the website, so a scan may replace it. */
export function isPlaceholderName(name: string, website: string | null | undefined): boolean {
  const auto = nameFromDomain(website);
  return auto !== null && normalizeName(name) === normalizeName(auto);
}

export function formatPhone(normalized: string | null): string | null {
  if (!normalized || normalized.length !== 10) return normalized;
  return `(${normalized.slice(0, 3)}) ${normalized.slice(3, 6)}-${normalized.slice(6)}`;
}

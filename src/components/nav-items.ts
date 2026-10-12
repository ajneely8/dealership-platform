export const NAV_SECTIONS: { heading: string; items: readonly (readonly [string, string])[] }[] = [
  {
    heading: "Command",
    items: [
      ["/command", "Command Center"],
      ["/agents", "AI Agents"],
      ["/active", "Active Research"],
    ],
  },
  {
    heading: "Intelligence",
    items: [
      ["/prospects", "Prospecting"],
      ["/dealerships", "Dealership Intelligence"],
      ["/opportunities", "Opportunity Scores"],
      ["/intel", "Sales Intelligence"],
      ["/evidence", "Evidence Library"],
    ],
  },
  {
    heading: "Records",
    items: [
      ["/activity", "Activity History"],
      ["/interactions", "Interactions"],
      ["/signals", "Signals"],
      ["/groups", "Dealer groups"],
    ],
  },
  {
    heading: "Controls",
    items: [
      ["/settings", "Settings"],
      ["/suppression", "Suppression"],
      ["/jobs", "Jobs"],
      ["/audit", "Audit log"],
    ],
  },
];

export const PAGE_TITLES: Record<string, string> = Object.fromEntries(NAV_SECTIONS.flatMap((s) => s.items.map(([href, text]) => [href, text])));

/** The nav entry that owns a path, e.g. /dealerships/abc → /dealerships. */
export function sectionFor(path: string): string | undefined {
  return Object.keys(PAGE_TITLES).find((href) => path === href || path.startsWith(`${href}/`)) ?? (path === "/dashboard" ? "/command" : undefined);
}

/**
 * Vendor signatures. A signature matches when the needle appears in a script URL, iframe URL,
 * outbound link, or inline-script body. Only well-known hostnames are listed; anything not
 * recognised is reported as "unknown vendor" rather than guessed.
 */
export type Signature = { name: string; category: string; needles: string[] };
export type ChatSignature = Signature & { chatType: "AI" | "RULE_BASED" | "LIVE" | "UNKNOWN" };

export const CHAT_VENDORS: ChatSignature[] = [
  { name: "Podium", category: "Chat", needles: ["podium.com"], chatType: "LIVE" },
  { name: "CarNow", category: "Chat", needles: ["carnow.com"], chatType: "LIVE" },
  { name: "Gubagoo", category: "Chat", needles: ["gubagoo.io", "gubagoo.com"], chatType: "LIVE" },
  { name: "ActivEngage", category: "Chat", needles: ["activengage.com"], chatType: "LIVE" },
  { name: "LivePerson", category: "Chat", needles: ["liveperson.net", "lpsnmedia.net"], chatType: "LIVE" },
  { name: "Drift", category: "Chat", needles: ["drift.com", "driftt.com"], chatType: "RULE_BASED" },
  { name: "Intercom", category: "Chat", needles: ["intercom.io", "intercomcdn.com"], chatType: "UNKNOWN" },
  { name: "Tawk.to", category: "Chat", needles: ["tawk.to"], chatType: "LIVE" },
  { name: "LiveChat", category: "Chat", needles: ["livechatinc.com"], chatType: "LIVE" },
  { name: "Zendesk Chat", category: "Chat", needles: ["zdassets.com", "zopim.com"], chatType: "UNKNOWN" },
  { name: "Kenect", category: "Chat", needles: ["kenect.com"], chatType: "LIVE" },
  { name: "Impel", category: "Chat", needles: ["impel.io", "impel.ai"], chatType: "AI" },
  { name: "Matador AI", category: "Chat", needles: ["matador.ai"], chatType: "AI" },
  { name: "Fullpath", category: "Chat", needles: ["autoleadstar.com", "fullpath.com"], chatType: "AI" },
  { name: "CarChat24", category: "Chat", needles: ["carchat24.com"], chatType: "LIVE" },
  { name: "Dealer Inspire Conversations", category: "Chat", needles: ["conversations.dealerinspire.com"], chatType: "UNKNOWN" },
  { name: "CarCode", category: "Chat", needles: ["carcode.com"], chatType: "LIVE" },
  { name: "TECOBI", category: "Chat", needles: ["tecobi.com"], chatType: "UNKNOWN" },
  { name: "Numa", category: "Chat", needles: ["numa.com"], chatType: "AI" },
  { name: "HubSpot Chat", category: "Chat", needles: ["usemessages.com"], chatType: "UNKNOWN" },
  { name: "Birdeye", category: "Chat", needles: ["birdeye.com"], chatType: "UNKNOWN" },
  { name: "Tidio", category: "Chat", needles: ["tidio.co"], chatType: "UNKNOWN" },
  { name: "Crisp", category: "Chat", needles: ["crisp.chat"], chatType: "UNKNOWN" },
];

export const SCHEDULER_VENDORS: Signature[] = [
  { name: "Xtime", category: "Service scheduler", needles: ["xtime.com", "xtime.net"] },
  { name: "myKaarma", category: "Service scheduler", needles: ["mykaarma.com"] },
  { name: "Dealer-FX", category: "Service scheduler", needles: ["dealer-fx.com"] },
  { name: "Tekion", category: "Service scheduler", needles: ["tekioncloud.com"] },
  { name: "Affinitiv / AutoLoop", category: "Service scheduler", needles: ["autoloop.us", "autoloop.com", "affinitiv.com"] },
  { name: "TimeHighway", category: "Service scheduler", needles: ["timehighway.com"] },
  { name: "Update Promise", category: "Service scheduler", needles: ["updatepromise.com"] },
  { name: "CDK Service", category: "Service scheduler", needles: ["serviceedge.cdk.com", "cdkglobalonline.com"] },
  { name: "DealerSocket Service", category: "Service scheduler", needles: ["xrm.dealersocket.com"] },
];

export const TECHNOLOGY: Signature[] = [
  { name: "Dealer.com", category: "Website platform", needles: ["static.dealer.com", "pictures.dealer.com"] },
  { name: "Dealer Inspire", category: "Website platform", needles: ["dealerinspire.com"] },
  { name: "DealerOn", category: "Website platform", needles: ["dealeron.com", "dlron.us"] },
  { name: "CDK / Sincro", category: "Website platform", needles: ["sincrod.com", "cdk.com/", "cobalt.com"] },
  { name: "Dealer eProcess", category: "Website platform", needles: ["dealereprocess.com", "dealereprocess.net"] },
  { name: "Team Velocity", category: "Website platform", needles: ["teamvelocityportal.com", "teamvelocitymarketing.com"] },
  { name: "fusionZONE", category: "Website platform", needles: ["fzautomotive.com"] },
  { name: "Overfuel", category: "Website platform", needles: ["overfuel.com"] },
  { name: "Jazel", category: "Website platform", needles: ["jazel.com", "jazelauto.com"] },
  { name: "DealerFire", category: "Website platform", needles: ["dealerfire.com"] },
  { name: "Fox Dealer", category: "Website platform", needles: ["foxdealer.com"] },
  { name: "Dealer Spike", category: "Website platform", needles: ["dealerspike.com"] },
  { name: "DealerCenter", category: "Website platform", needles: ["dealercenter.net"] },
  { name: "Carsforsale.com", category: "Website platform", needles: ["carsforsale.com"] },
  { name: "WordPress", category: "Website platform", needles: ["/wp-content/", "/wp-includes/"] },
  { name: "Wix", category: "Website platform", needles: ["wixstatic.com"] },
  { name: "Squarespace", category: "Website platform", needles: ["squarespace.com"] },
  { name: "TradePending", category: "Trade-in tool", needles: ["tradepending.com"] },
  { name: "KBB Instant Cash Offer", category: "Trade-in tool", needles: ["kbb.com/instant-cash-offer", "trade-in-ping.kbb.com"] },
  { name: "Roadster", category: "Digital retail", needles: ["roadster.com"] },
  { name: "Darwin Automotive", category: "Digital retail", needles: ["darwinautomotive.com"] },
  { name: "AutoFi", category: "Digital retail", needles: ["autofi.com"] },
  { name: "RouteOne", category: "Digital retail", needles: ["routeone.net"] },
  { name: "700Credit", category: "Digital retail", needles: ["700dealer.com", "700credit.com"] },
  { name: "VinSolutions", category: "CRM", needles: ["vinsolutions.com", "vinmanager.com"] },
  { name: "DealerSocket", category: "CRM", needles: ["dealersocket.com"] },
  { name: "Elead", category: "CRM", needles: ["eleadcrm.com"] },
  { name: "CallRail", category: "Call tracking", needles: ["callrail.com"] },
  { name: "Marchex", category: "Call tracking", needles: ["marchex.io"] },
  { name: "CallSource", category: "Call tracking", needles: ["callsource.com"] },
  { name: "Google Tag Manager", category: "Analytics", needles: ["googletagmanager.com/gtm"] },
  { name: "Google Analytics", category: "Analytics", needles: ["google-analytics.com", "googletagmanager.com/gtag"] },
  { name: "Meta Pixel", category: "Advertising pixel", needles: ["connect.facebook.net"] },
  { name: "Google Ads", category: "Advertising pixel", needles: ["googleadservices.com", "googleads.g.doubleclick.net"] },
  { name: "TikTok Pixel", category: "Advertising pixel", needles: ["analytics.tiktok.com"] },
  { name: "Hireology", category: "Recruiting", needles: ["hireology.com"] },
];

/** Keywords searched for inside inline scripts, in-page. Hostname-like needles only (no generic words). */
export const INLINE_HINT_KEYWORDS: string[] = [...CHAT_VENDORS, ...SCHEDULER_VENDORS, ...TECHNOLOGY]
  .flatMap((s) => s.needles)
  .filter((n) => n.includes(".") && !n.startsWith("/"));

export const SOCIAL_HOSTS: { platform: string; hosts: string[] }[] = [
  { platform: "facebook", hosts: ["facebook.com", "fb.com"] },
  { platform: "instagram", hosts: ["instagram.com"] },
  { platform: "tiktok", hosts: ["tiktok.com"] },
  { platform: "youtube", hosts: ["youtube.com", "youtu.be"] },
  { platform: "x", hosts: ["twitter.com", "x.com"] },
  { platform: "linkedin", hosts: ["linkedin.com"] },
  { platform: "pinterest", hosts: ["pinterest.com"] },
];

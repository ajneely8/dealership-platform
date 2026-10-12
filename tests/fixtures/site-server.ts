import { createServer, type Server } from "node:http";

/**
 * LOCAL TEST SITE — "Fixture Motors" is not a real dealership.
 * A tiny dealership-shaped website used to exercise the scanner and the form-submission worker
 * without ever touching a real business. `npm run fixture-site` serves it on port 5311.
 */

export type FixtureSubmission = { path: string; receivedAt: string; fields: Record<string, string> };

const nav = `
<nav>
  <a href="/">Home</a>
  <a href="/new-inventory">New Inventory</a>
  <a href="/used-inventory">Used Inventory</a>
  <a href="/service">Service</a>
  <a href="/contact">Contact Us</a>
  <a href="/careers">Careers</a>
  <a href="/about">About Us</a>
  <a href="/admin/login">Staff</a>
</nav>`;

const page = (title: string, body: string, head = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | Fixture Motors (LOCAL TEST SITE)</title>
<style>body{font-family:system-ui;margin:0;padding:16px;max-width:900px}nav a{margin-right:12px}label{display:block;margin:8px 0}input,textarea,select{display:block;width:100%;max-width:360px;padding:6px}</style>
${head}</head><body>
<p style="background:#fde68a;padding:6px">LOCAL TEST SITE — not a real dealership</p>
${nav}
${body}
<footer>
  <a href="https://www.facebook.com/fixturemotors.test">Facebook</a>
  <a href="https://www.instagram.com/fixturemotors.test/">Instagram</a>
  <a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a>
  <a href="tel:+15555550100">(555) 555-0100</a>
</footer>
</body></html>`;

const jsonLd = `<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "AutoDealer",
  name: "Fixture Motors",
  telephone: "(555) 555-0100",
  address: { "@type": "PostalAddress", streetAddress: "100 Test Track Road", addressLocality: "Testville", addressRegion: "TX", postalCode: "78000" },
  geo: { latitude: 29.7, longitude: -98.1 },
  brand: [{ "@type": "Brand", name: "Fixture" }],
})}</script>`;

const vdpLinks = (kind: string, n: number) =>
  Array.from({ length: n }, (_, i) => `<li><a href="/vehicle-details/${kind}-2025-fixture-sedan-${i + 1}">2025 Fixture Sedan #${i + 1}</a></li>`).join("");

const leadForm = (heading: string, button: string, extra = "") => `
<section class="lead-form"><h2>${heading}</h2>
<form method="post" action="/lead">
  ${extra}
  <label>First Name <input name="firstName" required></label>
  <label>Last Name <input name="lastName" required></label>
  <label>Email <input type="email" name="email" required></label>
  <label>Phone <input type="tel" name="phone"></label>
  <label>Comments <textarea name="comments"></textarea></label>
  <label><input type="checkbox" name="newsletter"> Send me offers</label>
  <button type="submit">${button}</button>
</form></section>`;

/**
 * A small chat widget: a launcher button, a contact gate (name + phone), then a message box.
 * Replies come 1.5 s and 3.5 s after a message, like a scripted bot would.
 */
const FIXTURE_CHAT_WIDGET = `
(function(){
  var b=document.createElement("button");b.id="fx-chat-launcher";b.textContent="Chat with us";b.style.cssText="position:fixed;right:16px;bottom:16px;padding:10px 14px";
  document.body.appendChild(b);
  b.addEventListener("click",function(){
    b.remove();
    var p=document.createElement("div");p.id="fx-chat";p.style.cssText="position:fixed;right:16px;bottom:16px;width:320px;background:#fff;border:1px solid #999;padding:10px;font:14px system-ui";
    p.innerHTML='<div id="fx-log"><div>Fixture Bot: Hi! Before we start, what is your name and phone number?</div></div>'+
      '<form id="fx-gate"><input name="name" placeholder="Your name" required><input name="phone" type="tel" placeholder="Phone number" required><button type="submit">Start chat</button></form>';
    document.body.appendChild(p);
    document.getElementById("fx-gate").addEventListener("submit",function(e){
      e.preventDefault();
      e.target.remove();
      var box=document.createElement("textarea");box.placeholder="Type your message";p.appendChild(box);
      var send=document.createElement("button");send.textContent="Send";p.appendChild(send);
      function post(who,t){var d=document.createElement("div");d.textContent=who+": "+t;document.getElementById("fx-log").appendChild(d);}
      function go(){var t=box.value.trim();if(!t)return;box.value="";post("You",t);
        setTimeout(function(){post("Fixture Bot","Yes, that vehicle is still available at our Testville store.");},1500);
        setTimeout(function(){post("Fixture Bot","A product specialist will text you shortly with more details.");},3500);}
      send.addEventListener("click",go);
      box.addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();go();}});
    });
  });
})();`;

const ROUTES: Record<string, () => string> = {
  "/": () => page("Home", `<h1>Fixture Motors</h1><p>New and used vehicles in Testville.</p><form action="/search"><input type="search" name="q" placeholder="Search inventory"></form>`, `${jsonLd}<script src="/assets/chat-widget.js" async></script>`),
  "/new-inventory": () => page("New Inventory", `<h1>New Inventory</h1><p class="result-count">128 New Vehicles Found</p><ul>${vdpLinks("new", 12)}</ul>`),
  "/used-inventory": () => page("Used Inventory", `<h1>Used Inventory</h1><p class="result-count">212 Used Vehicles Found</p><ul>${vdpLinks("used", 12)}</ul>`),
  "/contact": () =>
    page(
      "Contact Us",
      `<h1>Contact Us</h1>${leadForm("Contact Us", "Send Message")}
       <section><h2>Get Pre-Approved</h2><form method="post" action="/finance">
         <label>Full Name <input name="name"></label><label>Email <input type="email" name="email"></label>
         <label>Social Security Number <input name="ssn"></label><label>Annual Income <input name="income"></label>
         <button type="submit">Apply</button></form></section>`,
    ),
  "/service": () =>
    page(
      "Service",
      `<h1>Service Center</h1><p>Call our service department to book: <a href="tel:+15555550101">(555) 555-0101</a></p>
       <section><h2>Request a Service Appointment</h2><form method="post" action="/service-request">
         <label>Name <input name="name" required></label><label>Email <input type="email" name="email" required></label>
         <label>Phone <input type="tel" name="phone"></label><label>Year <input name="year"></label>
         <label>Make <input name="make"></label><label>Model <input name="model"></label>
         <label>Mileage <input name="mileage"></label><label>Preferred Date <input type="date" name="preferredDate"></label>
         <label>Describe the service needed <textarea name="details"></textarea></label>
         <button type="submit">Request Appointment</button></form></section>`,
    ),
  "/careers": () =>
    page("Careers", `<h1>Careers at Fixture Motors</h1><h2>Open Positions</h2><ul class="jobs"><li class="job">BDC Representative</li><li class="job">Service Advisor</li><li class="job">Internet Sales Manager</li></ul>`),
  "/about": () => page("About Us", `<h1>About Us</h1><p>Family owned test fixture.</p>`),
  "/thank-you": () => page("Thank You", `<h1>Thank you</h1><p>Your request has been received.</p>`),
  "/admin/login": () => page("Staff", `<h1>Staff login</h1>`),
};

export async function startFixtureSite(port = 0): Promise<{ url: string; port: number; submissions: FixtureSubmission[]; visits: string[]; close: () => Promise<void> }> {
  const submissions: FixtureSubmission[] = [];
  const visits: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        submissions.push({ path: url.pathname, receivedAt: new Date().toISOString(), fields: Object.fromEntries(new URLSearchParams(body)) });
        res.writeHead(303, { location: "/thank-you" }).end();
      });
      return;
    }
    visits.push(url.pathname);
    if (url.pathname === "/robots.txt") return void res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /admin\n");
    if (url.pathname === "/assets/chat-widget.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(FIXTURE_CHAT_WIDGET);
    if (url.pathname === "/__submissions") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(submissions));
    const vdp = url.pathname.startsWith("/vehicle-details/");
    const render = vdp
      ? () => page("2025 Fixture Sedan", `<h1>2025 Fixture Sedan</h1><p>Stock #T1001</p>${leadForm("Check Availability", "Check Availability", `<input type="hidden" name="vin" value="1FIXTURE000000001">`)}`)
      : ROUTES[url.pathname];
    if (!render) return void res.writeHead(404, { "content-type": "text/html" }).end(page("Not Found", "<h1>Not found</h1>"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(render());
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  return { url: `http://127.0.0.1:${actual}`, port: actual, submissions, visits, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("tests/fixtures/site-server.ts")) {
  const port = Number(process.env.FIXTURE_PORT ?? 5311);
  startFixtureSite(port).then((s) => console.log(`[fixture-site] Fixture Motors (LOCAL TEST SITE) on ${s.url}`));
}

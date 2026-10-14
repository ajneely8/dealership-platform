"use client";

import { useEffect, useState } from "react";

const RELOAD_WINDOW_MS = 60_000;

/**
 * A page that is not found is, nine times out of ten, a tab opened before a new deploy whose old
 * scripts asked the new server for a page it no longer serves that way. One full reload fixes
 * that, so this page reloads itself once a minute at most; if the address is really unknown, it
 * says so. The timestamp (not a flag that is cleared) keeps React's double-run of effects in
 * development from turning the single reload into a loop.
 */
export default function NotFound() {
  const [reloaded, setReloaded] = useState(false);
  useEffect(() => {
    try {
      const key = `nf:${window.location.pathname}`;
      const last = Number(sessionStorage.getItem(key) ?? 0);
      if (!last || Date.now() - last > RELOAD_WINDOW_MS) {
        sessionStorage.setItem(key, String(Date.now()));
        window.location.reload();
        return;
      }
    } catch {
      // storage unavailable: fall through to the message
    }
    queueMicrotask(() => setReloaded(true));
  }, []);
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#05080f] p-6 text-text">
      <div className="max-w-md space-y-3 text-center">
        <div className="num text-[11px] uppercase tracking-[0.2em] text-muted">{reloaded ? "Not found" : "Refreshing"}</div>
        <h1 className="text-[22px] font-semibold">{reloaded ? "That page does not exist here." : "Loading the latest version…"}</h1>
        {reloaded ? (
          <p className="text-[14px] text-muted">
            The address may be from an older link. Go to the{" "}
            <a href="/command" className="text-blue-light hover:underline">
              Command Center
            </a>{" "}
            or the{" "}
            <a href="/dealerships" className="text-blue-light hover:underline">
              dealership list
            </a>
            .
          </p>
        ) : null}
      </div>
    </main>
  );
}

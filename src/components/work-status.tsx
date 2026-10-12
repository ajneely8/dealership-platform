"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type Status = {
  busy: boolean;
  current: { label: string; startedAt: string | null } | null;
  pending: string[];
  lastScan: { status: string; summary: string | null; completedAt: string | null } | null;
};

/**
 * Shows what the research workers are doing for this dealership right now, and reloads the
 * page data the moment they finish, so a scan never looks like it went into a void.
 */
export function WorkStatus({ dealershipId, initiallyBusy }: { dealershipId: string; initiallyBusy: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [tick, setTick] = useState(0);
  const wasBusy = useRef(initiallyBusy);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/dealerships/${dealershipId}/status`, { cache: "no-store" });
        if (!res.ok) return;
        const next = (await res.json()) as Status;
        if (stop) return;
        setStatus(next);
        if (wasBusy.current && !next.busy) router.refresh(); // work just finished: pull in the new results
        wasBusy.current = next.busy;
      } catch {
        // transient; try again on the next tick
      }
    };
    void poll();
    // Poll only while something is running; an idle page costs nothing.
    const timer = setInterval(() => {
      if (!wasBusy.current) return;
      setTick((t) => t + 1);
      void poll();
    }, 2500);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [dealershipId, router]);

  const busy = status?.busy ?? initiallyBusy;
  if (!busy) return null;
  const started = status?.current?.startedAt ? new Date(status.current.startedAt).getTime() : null;
  const secs = started ? Math.max(0, Math.round((Date.now() - started) / 1000)) : null;
  void tick; // re-render each tick so the timer advances
  return (
    <div role="status" className="mb-4 flex items-center gap-3 border-l-2 border-blue bg-blue-wash px-3 py-2 text-[13px]">
      <span aria-hidden className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue" />
      <span className="font-medium">{status?.current?.label ?? "Working"}…</span>
      {secs !== null ? <span className="num text-muted">{secs}s</span> : null}
      {status?.pending && status.pending.length > 1 ? <span className="text-muted">then {status.pending.slice(1).join(", ").toLowerCase()}</span> : null}
      <span className="ml-auto text-[12px] text-muted">This page updates on its own when it finishes.</span>
    </div>
  );
}

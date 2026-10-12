"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { PAGE_TITLES, sectionFor } from "./nav-items";

/** Breadcrumb for the current section; the user block is passed in from the server layout. */
export function TopBar({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const section = sectionFor(path);
  const deeper = section !== undefined && path !== section;
  return (
    <div className="flex h-11 items-center justify-between border-b border-line bg-surface px-4 md:px-6">
      <div className="num flex items-center gap-2 text-[11px] uppercase tracking-[0.1em] text-muted">
        <span>Command center</span>
        {section ? (
          <>
            <span className="text-slate">/</span>
            <span className={deeper ? "" : "text-text"}>{PAGE_TITLES[section]}</span>
          </>
        ) : null}
        {deeper ? (
          <>
            <span className="text-slate">/</span>
            <span className="text-text">Detail</span>
          </>
        ) : null}
      </div>
      <div className="flex items-center gap-4">
        <Clock />
        {children}
      </div>
    </div>
  );
}

function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="num hidden text-[12px] tracking-[0.08em] text-muted md:inline">{now ? now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : ""}</span>;
}

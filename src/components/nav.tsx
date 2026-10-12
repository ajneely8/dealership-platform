"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NavAgents } from "./nav-agents";
import { NAV_SECTIONS, sectionFor } from "./nav-items";

export function Nav({ pending }: { pending: number }) {
  const path = usePathname();
  const current = sectionFor(path);
  return (
    <nav className="flex flex-col gap-5 px-3 py-4" aria-label="Primary">
      {NAV_SECTIONS.map((section) => (
        <div key={section.heading}>
          <div className="eyebrow mb-1.5 px-2 text-[#54718e]">{section.heading}</div>
          <ul className="space-y-px">
            {section.items.map(([href, text]) => {
              const active = href === current;
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={`relative flex items-center justify-between rounded-sm px-2 py-1.5 text-[13px] ${active ? "bg-charcoal-2 font-medium text-text" : "text-[#c3d2e6] hover:bg-charcoal-2 hover:text-text"}`}
                  >
                    {active ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 bg-blue" /> : null}
                    {text}
                    {href === "/interactions" && pending > 0 ? <span className="num rounded-sm bg-blue px-1.5 text-[11px] font-medium text-white">{pending}</span> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
          {section.heading === "Command" ? (
            <>
              <div className="eyebrow mb-1 mt-3 px-2 text-[#54718e]">Agents</div>
              <NavAgents />
            </>
          ) : null}
        </div>
      ))}
    </nav>
  );
}

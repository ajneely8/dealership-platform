import { describe, expect, it } from "vitest";
import { isWithinWindow, localParts, nextWindowStart, type WindowConfig } from "@/domain/research-window";

const cfg: WindowConfig = { enabled: true, start: "07:00", end: "21:00", timezone: "America/Chicago" };

describe("research window (America/Chicago, DST-aware)", () => {
  it("knows the wall clock in the zone on both sides of a DST change", () => {
    // 2026-03-08: clocks spring forward at 02:00 CST → 03:00 CDT. Offsets: CST = UTC-6, CDT = UTC-5.
    expect(localParts(new Date("2026-03-08T12:30:00Z"), "America/Chicago").minutes).toBe(7 * 60 + 30); // CST
    expect(localParts(new Date("2026-03-09T12:30:00Z"), "America/Chicago").minutes).toBe(7 * 60 + 30); // CDT
    // 2026-11-01: fall back. 12:30Z is 07:30 CDT before, 06:30 CST after.
    expect(localParts(new Date("2026-10-31T12:30:00Z"), "America/Chicago").minutes).toBe(7 * 60 + 30);
    expect(localParts(new Date("2026-11-02T12:30:00Z"), "America/Chicago").minutes).toBe(6 * 60 + 30);
  });

  it("is open 07:00–20:59 local and closed outside, in summer and winter", () => {
    // Summer (CDT, UTC-5): 06:59 local = 11:59Z, 07:00 = 12:00Z, 20:59 = 01:59Z next day, 21:00 = 02:00Z.
    expect(isWithinWindow(new Date("2026-07-01T11:59:00Z"), cfg)).toBe(false);
    expect(isWithinWindow(new Date("2026-07-01T12:00:00Z"), cfg)).toBe(true);
    expect(isWithinWindow(new Date("2026-07-02T01:59:00Z"), cfg)).toBe(true);
    expect(isWithinWindow(new Date("2026-07-02T02:00:00Z"), cfg)).toBe(false);
    // Winter (CST, UTC-6): 07:00 local = 13:00Z.
    expect(isWithinWindow(new Date("2026-01-15T12:59:00Z"), cfg)).toBe(false);
    expect(isWithinWindow(new Date("2026-01-15T13:00:00Z"), cfg)).toBe(true);
    expect(isWithinWindow(new Date("2026-01-16T03:00:00Z"), cfg)).toBe(false);
  });

  it("runs every day of the week and can be switched off", () => {
    expect(isWithinWindow(new Date("2026-07-05T15:00:00Z"), cfg)).toBe(true); // a Sunday
    expect(isWithinWindow(new Date("2026-07-05T05:00:00Z"), { ...cfg, enabled: false })).toBe(true);
  });

  it("finds the next opening, including across the DST switch-over", () => {
    // 22:00 CDT on 2026-07-01 (03:00Z Jul 2) → next 07:00 CDT = 12:00Z Jul 2.
    expect(nextWindowStart(new Date("2026-07-02T03:00:00Z"), cfg).toISOString()).toBe("2026-07-02T12:00:00.000Z");
    // 23:00 CST on 2026-03-07 (05:00Z Mar 8) → next 07:00 on Mar 8 is CDT = 12:00Z (not 13:00Z).
    expect(nextWindowStart(new Date("2026-03-08T05:00:00Z"), cfg).toISOString()).toBe("2026-03-08T12:00:00.000Z");
    // 23:00 CDT on 2026-10-31 (04:00Z Nov 1) → next 07:00 on Nov 1 is CST = 13:00Z.
    expect(nextWindowStart(new Date("2026-11-01T04:00:00Z"), cfg).toISOString()).toBe("2026-11-01T13:00:00.000Z");
    // Inside the window, the next start is tomorrow's.
    expect(nextWindowStart(new Date("2026-07-01T15:00:00Z"), cfg).toISOString()).toBe("2026-07-02T12:00:00.000Z");
  });

  it("supports a window that crosses midnight", () => {
    const night = { ...cfg, start: "22:00", end: "02:00" };
    expect(isWithinWindow(new Date("2026-07-02T04:00:00Z"), night)).toBe(true); // 23:00 CDT
    expect(isWithinWindow(new Date("2026-07-02T06:30:00Z"), night)).toBe(true); // 01:30 CDT
    expect(isWithinWindow(new Date("2026-07-02T08:00:00Z"), night)).toBe(false); // 03:00 CDT
  });
});

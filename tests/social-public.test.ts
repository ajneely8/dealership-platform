import { describe, expect, it } from "vitest";
import { parseCount, parsePublicProfile } from "@/workers/social/public-profile";

describe("public social profile reading", () => {
  it("parses compact counts", () => {
    expect(parseCount("1,234")).toBe(1234);
    expect(parseCount("12.3K")).toBe(12300);
    expect(parseCount("2M")).toBe(2_000_000);
    expect(parseCount("lots")).toBeNull();
  });
  it("reads Instagram and YouTube counts from page metadata", () => {
    const ig = `<html><head><title>Example Motors (@examplemotors) • Instagram photos and videos</title><meta property="og:description" content="4,512 Followers, 310 Following, 1,208 Posts - See Instagram photos and videos from Example Motors (@examplemotors)"></head></html>`;
    expect(parsePublicProfile(ig, "instagram")).toMatchObject({ followers: 4512, totalPosts: 1208, publiclyVisible: true });
    const yt = `<html><head><title>Example Motors - YouTube</title><meta name="description" content="Example Motors. 2.1K subscribers. 87 videos. Serving Testville since 1966."></head></html>`;
    expect(parsePublicProfile(yt, "youtube")).toMatchObject({ followers: 2100, totalPosts: 87 });
  });
  it("reports a login wall instead of working around it", () => {
    const wall = `<html><head><title>Log into Facebook</title><meta property="og:description" content="Log into Facebook to start sharing and connecting with your friends, family, and people you know."></head></html>`;
    const r = parsePublicProfile(wall, "facebook");
    expect(r).toMatchObject({ followers: null, totalPosts: null, publiclyVisible: false });
    expect(r.note).toContain("sign-in page");
  });
  it("says so when a public page shows no counts", () => {
    const r = parsePublicProfile(`<html><head><title>Example Motors</title></head></html>`, "tiktok");
    expect(r).toMatchObject({ followers: null, publiclyVisible: true });
    expect(r.note).toContain("no follower or post counts");
  });
});

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/env";
import { redis } from "@/queue";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Fixed-window rate limit in Redis. Returns false when the caller is over the limit. */
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const k = `rl:${key}`;
  const n = await redis().incr(k);
  if (n === 1) await redis().expire(k, windowSeconds);
  return n <= limit;
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

/** Shared-secret check for providers that can send a custom header. */
export function verifySharedSecret(req: Request): "ok" | "unconfigured" | "denied" {
  const secret = env().WEBHOOK_SECRET;
  if (!secret) return "unconfigured";
  const given = req.headers.get("x-webhook-secret") ?? "";
  return safeEqual(given, secret) ? "ok" : "denied";
}

/**
 * Twilio request validation: HMAC-SHA1 over the full URL followed by each POST field
 * (sorted by name, name+value concatenated), base64-encoded, compared with X-Twilio-Signature.
 */
export function verifyTwilioSignature(req: Request, pathname: string, params: Record<string, string>): "ok" | "unconfigured" | "denied" {
  const token = env().TWILIO_AUTH_TOKEN;
  if (!token) return "unconfigured";
  const url = `${env().APP_URL.replace(/\/$/, "")}${pathname}`;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = createHmac("sha1", token).update(data).digest("base64");
  return safeEqual(req.headers.get("x-twilio-signature") ?? "", expected) ? "ok" : "denied";
}

/** A webhook is accepted when either configured mechanism verifies it; with neither configured it is refused. */
export function authorizeWebhook(req: Request, pathname: string, formParams: Record<string, string> | null): Response | null {
  const checks = [verifySharedSecret(req), formParams ? verifyTwilioSignature(req, pathname, formParams) : "unconfigured"];
  if (checks.includes("ok")) return null;
  if (checks.every((c) => c === "unconfigured")) return Response.json({ error: "Webhook authentication is not configured on the server." }, { status: 503 });
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

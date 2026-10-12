import { z } from "zod";
import type { Channel } from "@/domain/constants";
import { ingestInbound } from "@/domain/responses";
import { logger } from "@/lib/logger";
import { authorizeWebhook, clientIp, rateLimit } from "@/lib/webhook";

export const dynamic = "force-dynamic";

const CHANNEL: Record<string, Channel> = { sms: "SMS", email: "EMAIL", phone: "PHONE" };

/** Provider-neutral JSON body. Twilio's form-encoded SMS/voice webhooks are also accepted. */
const jsonBody = z.object({
  from: z.string().max(320),
  to: z.string().max(320),
  text: z.string().max(100_000).optional(),
  subject: z.string().max(500).optional(),
  messageId: z.string().max(300).optional(),
  receivedAt: z.coerce.date().optional(),
});

/**
 * POST /api/webhooks/sms | email | phone
 * Records a dealership's reply to a test identity and stops the response timer for that channel.
 * Authenticated by the x-webhook-secret header, or by Twilio's request signature.
 */
export async function POST(req: Request, { params }: { params: Promise<{ channel: string }> }) {
  const { channel: slug } = await params;
  const channel = CHANNEL[slug];
  if (!channel) return Response.json({ error: "Unknown channel" }, { status: 404 });
  if (!(await rateLimit(`webhook:${clientIp(req)}`, 240, 60))) return Response.json({ error: "Too many requests" }, { status: 429 });

  const pathname = new URL(req.url).pathname;
  const type = req.headers.get("content-type") ?? "";
  let input: z.infer<typeof jsonBody>;
  let form: Record<string, string> | null = null;
  try {
    if (type.includes("application/x-www-form-urlencoded")) {
      form = Object.fromEntries(new URLSearchParams(await req.text()));
      input = jsonBody.parse({ from: form.From, to: form.To, text: form.Body, messageId: form.MessageSid ?? form.CallSid });
    } else {
      input = jsonBody.parse(await req.json());
    }
  } catch {
    return Response.json({ error: "Invalid payload" }, { status: 400 });
  }

  const denied = authorizeWebhook(req, pathname, form);
  if (denied) return denied;

  const receivedAt = input.receivedAt ?? new Date();
  const message = channel === "PHONE" ? null : [input.subject ? `Subject: ${input.subject}` : null, input.text].filter(Boolean).join("\n\n") || null;
  try {
    const result = await ingestInbound({ channel, receivedAt, sender: input.from, recipient: input.to, message, externalId: input.messageId ? `${slug}:${input.messageId}` : null });
    // Always 200 for authenticated, well-formed deliveries so providers don't retry forever; unmatched ones are parked for review.
    return Response.json(result);
  } catch (err) {
    logger.error({ err: (err as Error).message, channel }, "webhook ingest failed");
    return Response.json({ error: "Could not record the message" }, { status: 500 });
  }
}

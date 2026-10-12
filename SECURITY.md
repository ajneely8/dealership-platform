# Security & research conduct

## Research conduct rules (enforced in code)

The goal is to measure a dealership's systems, not to deceive its staff.

| Rule | Where it is enforced |
|---|---|
| No finance/credit applications, SSNs, trade-ins, appointment bookings or test-drive requests | `env.ts` refuses to boot if any `ALLOW_*` flag is `true`; `SUBMITTABLE_FORM_TYPES` + prohibited-field detection in `eligibility.ts`; no code path fills such fields |
| Only company-owned identities | Identities are created by an admin who must confirm ownership; the system never generates one |
| Only pre-approved, low-intent questions | `APPROVED_MESSAGES`; free text is rejected |
| One test per dealership per 30 days minimum | Cooldown floor of 30 days in `evaluateEligibility` regardless of settings |
| Never test a suppressed account | Suppression checked at request, approval, and immediately before submission |
| No duplicate tests | Active-test check + atomic claim + `attempts: 1` on the interaction queue |
| No CAPTCHA bypass, no access-control evasion | CAPTCHA or challenge page → `BLOCKED`, run ends; robots.txt honoured; the crawler identifies itself |
| Never keep staff engaged | The system never replies to a dealership. Chat tests are run by a person, capped at `maxChatMessages` |
| No fabricated evidence | Every score reason and brief claim carries evidence refs; claims without evidence are dropped; AI text with unsupported numbers is discarded |
| No invented contacts | Briefs show roles only; a named contact needs a source URL |

**Your responsibility:** submitting test inquiries to businesses has legal and ethical dimensions (terms of use, consumer-protection and telemarketing rules, and what your identity's consent checkbox agrees to). Get your own legal review before enabling controlled testing. It is off by default.

## Application security

| Control | Implementation |
|---|---|
| Authentication | Email + password (scrypt, per-user salt). Session is a signed JWT (HS256) in an `httpOnly`, `SameSite=Lax` cookie, `Secure` in production, 12-hour expiry. The user row is re-read on every request, so deactivation and role changes apply immediately. |
| Authorisation | Roles: VIEWER (read), OPERATOR (research, requests, approvals, suppression), ADMIN (settings, identities, users, deletes, enabling testing). Every server action calls `requireRole`. Every page under `(app)` calls `requireUser`. |
| CSRF | All mutations are Next.js Server Actions (POST only, Origin/Host checked by the framework) behind a `SameSite=Lax` cookie. Webhooks use their own authentication instead of cookies. |
| Rate limiting | Sign-in: 8 attempts / 15 min per account. Webhooks: 240 / min per IP. Both in Redis. |
| Input validation | zod on every server action and webhook; CSV rows validated individually; UUIDs validated before queries. |
| SQL safety | Drizzle query builder / parameterised SQL only. |
| Secrets | Read from server environment only (`src/env.ts`). Nothing secret is sent to the browser — Settings shows only whether an AI key exists. Logs redact password/token/secret fields. |
| Evidence access | Screenshots are served through `/api/evidence/[id]` to signed-in users; bucket URLs and storage keys are not exposed. |
| SSRF | The crawler refuses private and local addresses in production. |
| Transcripts | Text that looks like a password, one-time code or SSN is redacted before storage. |
| Headers | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`. |
| Open redirects | Post-action redirects accept same-site relative paths only. |
| Audit | Tests, suppression changes, score changes, identity and settings changes, imports and sign-ins are written to `audit_logs`. |

## Webhook authentication

`POST /api/webhooks/sms | email | phone`

- **Shared secret:** set `WEBHOOK_SECRET`; the provider sends it as the `x-webhook-secret` header.
- **Twilio:** set `TWILIO_AUTH_TOKEN`; the `X-Twilio-Signature` header is verified. `APP_URL` must exactly match the public URL Twilio calls.

If neither is configured the endpoint returns 503 and records nothing.

JSON body: `{ "from": "...", "to": "...", "text": "...", "subject": "...", "messageId": "...", "receivedAt": "ISO date" }`. Twilio's form-encoded format is also accepted.

## Known gaps (not built)

- No password reset, MFA or SSO. Users are created by an admin; deactivate one by setting `users.active = false` in the database.
- No TLS termination in the app. Run it behind a reverse proxy that enforces HTTPS.
- No per-user rate limiting on normal pages.
- Evidence is not encrypted by the app; use bucket-level encryption.
- The app has had no external security review.

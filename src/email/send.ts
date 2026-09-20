/**
 * Outbound email, behind an injectable transport (story #23 AC 2).
 *
 * Everything that sends mail takes a Transport and never reaches for Resend itself, so a test
 * hands in a fake and asserts on the recipients it saw; the one real implementation below is a
 * single POST to Resend's REST API, which is all the `resend` SDK wraps for this call and is
 * why there is no dependency. The API key is read here and nowhere else in src/ — AC 7 holds
 * that by grep (test/notify-call-sites.test.ts): no client component names the provider, and
 * no public-prefixed spelling of the key exists for a bundle to inline.
 *
 * Sends from the club's own domain (README runbook: Resend verifies tender.madcowsailing.com,
 * which also carries the password resets). Text only: a notification read on a phone on a Saturday
 * night needs the date, the boat and a link, not a layout. The one file ever attached is the
 * crew's race .ics on the match email (story #34).
 */

import { env } from "@/lib/env";

export interface Message {
  to: string;
  subject: string;
  text: string;
  /** Files sent with the message (story #34: the crew's race .ics). Absent means none. */
  attachments?: Attachment[];
}

/** One attached file. `content` is the file's text; the transport encodes it for the wire. */
export interface Attachment {
  filename: string;
  content: string;
  contentType: string;
}

export interface Transport {
  /** Resolves with the provider's id for the send; rejects when the provider refused it. */
  send(message: Message): Promise<{ id: string }>;
}

export const FROM = "Tender <tender@tender.madcowsailing.com>";

/**
 * Where the POST goes. RESEND_BASE_URL is an override for a stack that must not reach the real
 * provider — the local verification recipe points it at a stub that records recipients and
 * answers an id. Unset in production, and absent from .env.local.
 */
export function resendUrl(baseUrl: string | undefined = process.env.RESEND_BASE_URL): string {
  return `${(baseUrl ?? "https://api.resend.com").replace(/\/$/, "")}/emails`;
}

/**
 * The real transport. `fetch` is injectable so the request shape is unit-tested without a
 * network; the key defaults to the server's RESEND_API_KEY and is never exported.
 */
export function resendTransport(
  apiKey: string | undefined = env("RESEND_API_KEY"),
  fetchImpl: typeof fetch = fetch,
  url: string = resendUrl(),
): Transport {
  // The default above throws with the name on it (story #65); this still guards the caller who
  // passes an explicit empty string, which skips the default entirely. Same message either way.
  if (!apiKey) throw new Error("RESEND_API_KEY is not set");
  return {
    async send(message) {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          // Resend's REST shape: base64 content, the filename, and content_type. Omitted entirely
          // when there is nothing to attach, so every other message's request is unchanged.
          ...(message.attachments?.length
            ? {
                attachments: message.attachments.map((a) => ({
                  filename: a.filename,
                  content: Buffer.from(a.content, "utf8").toString("base64"),
                  content_type: a.contentType,
                })),
              }
            : {}),
        }),
      });
      if (!res.ok) {
        // Resend answers a JSON body naming the refusal; keep it short, it lands in notification_log.error.
        const body = (await res.text()).slice(0, 200);
        throw new Error(`resend ${res.status}: ${body}`);
      }
      const json = (await res.json()) as { id?: unknown };
      if (typeof json.id !== "string") throw new Error("resend: no id in response");
      return { id: json.id };
    },
  };
}

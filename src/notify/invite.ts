import type { Message, Transport } from "@/email/send";
import { EMAIL_SKIP_AT, type LogEntry } from "./rung";

/**
 * sendInvites(): email a pasted list of addresses the club's invite code (story #31).
 *
 * Workflow 1's second clause. The admin pastes addresses into /admin/invite, Tender sends each
 * one the /join link, the current code and the home-screen install steps, and reports back what
 * it did with every line — including the ones it did not send.
 *
 * WHY THIS ONE IS SHAPED UNLIKE THE OTHER FIVE SENDERS. notifyRung, notifyAnswer, notifyMatch,
 * notifyMessage and remindCrew each notify ONE person about ONE thing that just happened, and
 * every one of them is addressed to a member — a person row, a contact row, a rung. This is a
 * BATCH, addressed to people who are by definition NOT members yet, so:
 *
 *   - There is no `person_id` on any row it logs. `notification_log.person_id` is nullable
 *     (0010) and an invitee has no person row to point at; `to_email` is the whole record of
 *     who was reached. `post_id` is null for the same reason — no post is involved.
 *   - The cap is checked ONCE for the whole batch, not per recipient, and refuses everything
 *     (AC 2). Every other sender skips the individual send it cannot afford and logs
 *     `…_skipped_cap`, because there the alternative is not notifying somebody about a thing
 *     that already happened. Here the batch is one admin action with one outcome, and a half-sent
 *     invite list is worse than a refused one: the admin cannot tell from twenty inboxes which
 *     ten went, and re-pasting the list would double-invite the first ten. Owner decision
 *     2026-09-18.
 *   - It is the only sender whose recipients come from a FORM rather than from the database, so
 *     parsing and de-duplicating the list is part of the job (AC 1) and the addresses are never
 *     trusted as well-formed.
 *
 * Pure over its inputs, like every module here: the store, the transport and `now` are injected,
 * so the tests count recipients exactly against an in-memory store and a fake transport.
 */

/** One invite email attempted — accepted or refused by the provider; `error` says which (AC 1). */
export const KIND_INVITE = "invite";

/**
 * The most addresses one paste may carry (AC 1). Fifty is the story's number and a season's
 * roster with room to spare; it also keeps a single batch well inside the daily cap, so the
 * refusal in AC 2 is about the day's other traffic rather than about the list's own size.
 */
export const INVITE_MAX = 50;

/**
 * An address as parsed out of the pasted text, before anything is sent.
 *
 * `raw` is kept alongside `email` because the report has to name the line the admin typed: told
 * that "dave@" is malformed they can find it, told that "" is malformed they cannot.
 */
export type ParsedAddress = { raw: string; email: string };

export type ParsedList = {
  /** Well-formed, lowercased, de-duplicated, in the order first seen. */
  valid: ParsedAddress[];
  /** Lines that are not addresses, as typed, in order. Listed back unsent (AC 1). */
  malformed: string[];
  /** Well-formed lines that repeat an earlier one. Sent once; reported so the count adds up. */
  duplicates: string[];
};

/**
 * Split a paste into addresses. Commas, semicolons, whitespace and newlines all separate, because
 * a paste out of a spreadsheet column, a mail client's To: field or a hand-typed list all arrive
 * differently and the admin should not have to care which.
 *
 * The validity test is deliberately not an RFC 5322 parser: one `@`, something either side, a dot
 * in the domain, no whitespace. That accepts every address a sailing club will ever have and
 * rejects the things a paste actually goes wrong with — a bare name, a trailing comma, "dave@",
 * a stray "and". The provider is the real judge of deliverability and its refusal is logged per
 * address (AC 1); this is only here so an obvious typo is caught before it spends a cap slot.
 *
 * `<Dave Smith> dave@example.org` and `Dave <dave@example.org>` both appear in real pastes, so a
 * bracketed address is unwrapped rather than rejected.
 */
export function parseAddressList(text: string): ParsedList {
  const valid: ParsedAddress[] = [];
  const malformed: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();

  for (const piece of splitPaste(text)) {
    const email = unwrap(piece).toLowerCase();
    if (!isAddress(email)) {
      malformed.push(piece);
      continue;
    }
    if (seen.has(email)) {
      duplicates.push(piece);
      continue;
    }
    seen.add(email);
    valid.push({ raw: piece, email });
  }

  return { valid, malformed, duplicates };
}

/**
 * Split on every plausible separator, dropping empties. A display name with a space in it is why
 * whitespace cannot be the only separator and why `unwrap` exists: splitting
 * `Dave Smith <dave@example.org>` on whitespace yields three pieces, two of them malformed. So a
 * line carrying `<…>` is taken whole and unwrapped, and only the rest is split on whitespace.
 */
function splitPaste(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/[\r\n,;]+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/<[^>]*>/.test(trimmed)) out.push(trimmed);
    else for (const word of trimmed.split(/\s+/)) if (word) out.push(word);
  }
  return out;
}

/** `Dave <dave@example.org>` → `dave@example.org`. Anything else is returned as it came. */
function unwrap(piece: string): string {
  const m = piece.match(/<([^>]*)>/);
  return (m ? m[1] : piece).trim();
}

function isAddress(email: string): boolean {
  if (/\s/.test(email)) return false;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return false;
  const domain = email.slice(at + 1);
  const dot = domain.indexOf(".");
  return dot > 0 && dot < domain.length - 1;
}

export interface InviteStore {
  /** The club's current invite code, as the service role. */
  inviteCode(): Promise<string>;
  /**
   * Which of these addresses already hold a person row, lowercased (AC 3). A set rather than a
   * per-address call: one read of person_contact, whatever the list's length.
   */
  members(emails: string[]): Promise<Set<string>>;
  /** Email sends attempted so far in the day `now` falls in, all kinds — the cap's count. */
  emailsSentToday(now: Date): Promise<number>;
  log(entry: LogEntry): Promise<void>;
}

export type InviteDeps = {
  store: InviteStore;
  transport: Transport;
  now: Date;
  /** The site's origin, for the /join link in the email. */
  siteUrl: string;
};

/** What happened to one address. Every parsed line ends up with exactly one of these. */
export type InviteOutcome =
  | { email: string; state: "sent"; providerId: string }
  | { email: string; state: "refused"; error: string }
  | { email: string; state: "member" };

export type InviteResult = {
  outcomes: InviteOutcome[];
  /** Lines that were not addresses, as typed (AC 1). */
  malformed: string[];
  /** Well-formed lines repeating an earlier one. Sent once. */
  duplicates: string[];
  /**
   * Set when nothing was sent at all, and why. `cap` carries how many would have fit (AC 2);
   * `too_many` is a paste over INVITE_MAX; `empty` is a paste with no valid address in it.
   */
  refusal?: { reason: "cap"; fits: number } | { reason: "too_many"; max: number } | { reason: "empty" };
};

/** What an invitee reads. Exported so the copy is tested (AC 4), not so anything else sends it. */
export function inviteEmail(to: string, code: string, siteUrl: string): Message {
  return {
    to,
    subject: "You're invited to Tender — the Mad Cow crew board",
    text: [
      `You've been invited to Tender, where Mad Cow skippers post the boats that need crew and`,
      `crew say which days they can sail.`,
      ``,
      // #218: the sign-up tab by name. Plain /join opens on Sign in for a device that has signed in
      // here before (#123), which is not where someone holding a fresh invite code needs to be.
      `Join here: ${siteUrl}/join?mode=signup`,
      `Your invite code: ${code}`,
      ``,
      `Once you're in, add Tender to your home screen so a skipper's post can reach your phone:`,
      `on an iPhone tap Share at the bottom of Safari, then Add to Home Screen; on Android open`,
      `the browser menu and tap Install app.`,
      ``,
      `Tender — the crew board.`,
    ].join("\n"),
  };
}

/**
 * Send the invites. The order of the three refusals matters and is the order of the ACs:
 *
 *   1. Nothing to send — an empty paste, or one with no well-formed address in it. No cap read,
 *      no member read, nothing logged: the admin mistyped and there is no send to refuse.
 *   2. More than INVITE_MAX addresses (AC 1's ceiling).
 *   3. The day's cap (AC 2), counted over the addresses that would ACTUALLY be sent — after the
 *      already-a-member skips are removed, because a skip sends no email and must not count
 *      against the cap it does not spend. This is checked before the first send and refuses the
 *      whole batch, which is the difference from every other sender here (see the header).
 *
 * The member read therefore happens BEFORE the cap read, which is the opposite of what the ACs'
 * order suggests and is what makes the number in AC 2's refusal honest.
 */
export async function sendInvites(text: string, deps: InviteDeps): Promise<InviteResult> {
  const { store, transport, now, siteUrl } = deps;
  const { valid, malformed, duplicates } = parseAddressList(text);

  if (valid.length === 0) {
    return { outcomes: [], malformed, duplicates, refusal: { reason: "empty" } };
  }
  if (valid.length > INVITE_MAX) {
    return { outcomes: [], malformed, duplicates, refusal: { reason: "too_many", max: INVITE_MAX } };
  }

  // AC 3 — already a member, skipped and reported. Case-insensitively: the addresses are
  // lowercased by the parser and the store lowercases what it reads back, so a member who
  // signed up as Dave@Example.org is still recognised in a paste of dave@example.org.
  const members = await store.members(valid.map((a) => a.email));
  const toSend = valid.filter((a) => !members.has(a.email));
  const skipped: InviteOutcome[] = valid
    .filter((a) => members.has(a.email))
    .map((a) => ({ email: a.email, state: "member" as const }));

  if (toSend.length === 0) {
    // Everybody pasted is already in. Not a refusal — the admin asked for something that was
    // already true, and the report says so per address.
    return { outcomes: skipped, malformed, duplicates };
  }

  // AC 2 — the day's cap, over the batch as a whole. `fits` is what the admin is told, so it is
  // computed from the same two numbers the refusal is: never negative, and zero when the day is
  // already spent.
  const sentToday = await store.emailsSentToday(now);
  const fits = Math.max(0, EMAIL_SKIP_AT - sentToday);
  if (toSend.length > fits) {
    // Nothing is sent and nothing is logged. A refusal is not an attempt on the provider, so
    // logging it here would spend cap slots tomorrow's count reads (the KIND_MESSAGE_NO_ADDRESS
    // precedent, #35: only attempts go on the list `emailsSentToday` counts).
    return { outcomes: skipped, malformed, duplicates, refusal: { reason: "cap", fits } };
  }

  const code = await store.inviteCode();
  const outcomes: InviteOutcome[] = [...skipped];
  for (const address of toSend) {
    try {
      const { id } = await transport.send(inviteEmail(address.email, code, siteUrl));
      outcomes.push({ email: address.email, state: "sent", providerId: id });
      await store.log({ kind: KIND_INVITE, channel: "email", personId: null, toEmail: address.email, postId: null, providerId: id, error: null });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      // Logged as an ATTEMPT, like every other sender's refusal: the provider was called and
      // the call counts against the day. The admin sees which addresses to retry.
      outcomes.push({ email: address.email, state: "refused", error });
      await store.log({ kind: KIND_INVITE, channel: "email", personId: null, toEmail: address.email, postId: null, providerId: null, error });
    }
  }
  return { outcomes, malformed, duplicates };
}

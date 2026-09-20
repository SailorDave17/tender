/**
 * When a thread closes, and what a party may do in it (story #35 AC 5). Pure, with `now`
 * injected, for the same reason `src/dates/race-date.ts` is: the club is in one zone and a rule
 * about elapsed days must not be decided on whatever clock the server happens to run on.
 *
 * The rule: seven days after the race starts, the thread is read-only. Both parties still read
 * every message — the record does not disappear — but nothing more can be said.
 *
 * WHY SEVEN DAYS RATHER THAN AT THE RACE. The thread's purpose does not end when the boat
 * leaves the dock: "thanks", "you left your gloves", "same next week" all land afterwards, and
 * a thread that shut at the start would push exactly those back to hunting for a number, which
 * is the thing this story exists to stop. Seven days is the issue's figure and is a recorded
 * default, not a derived one.
 *
 * WHY A WINDOW AT ALL. A match is a one-off arrangement between two people who may not know
 * each other; an indefinitely open channel to somebody's inbox is a different product with
 * different obligations (moderation, blocking, reporting), and those are deliberately split out
 * of this story. Closing the thread bounds the commitment to the thing that was agreed.
 */

/** How long after the race start a thread stays writable. A recorded default (AC 5). */
export const THREAD_OPEN_DAYS = 7;

/**
 * The longest message body, in characters (AC 2).
 *
 * ONE NUMBER, THREE ENFORCEMENT POINTS, and they are not redundant: `maxLength` on the textarea
 * stops a person overshooting, the server action refuses politely, and 0020's
 * `check (length(body) between 1 and 2000)` is where the rule is actually TRUE — a Server Action
 * is a POST endpoint anyone can call, so the only cap that cannot be bypassed is the table's.
 * `test/migrations-hygiene.test.ts` holds this constant equal to the migration's literal, so the
 * three cannot drift apart silently (cairn: a-computable-claim-does-not-belong-in-prose).
 */
export const MESSAGE_BODY_MAX = 2000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When the thread stops accepting messages: seven days after the race's start instant.
 *
 * Measured from `starts_at`, an absolute instant, so no timezone arithmetic is involved and the
 * answer cannot move with the server's locale. The club's wall clock matters for *displaying* a
 * race time (race-date.ts) and not for measuring elapsed days from one.
 */
export function threadClosesAt(startsAt: string): Date {
  return new Date(new Date(startsAt).getTime() + THREAD_OPEN_DAYS * DAY_MS);
}

/**
 * Is the thread still writable? `now` is injected and never defaulted — a default would make
 * every caller's clock invisible, and this is the one decision in the story that a wrong clock
 * silently reverses.
 */
export function threadIsOpen(startsAt: string, now: Date): boolean {
  return now.getTime() < threadClosesAt(startsAt).getTime();
}

/**
 * What both parties see in place of a message the admin removed (story #36 AC 2).
 *
 * THE SAME SENTENCE IS STORED IN THE ROW. `remove_message()` (0023) moves the original body to
 * the admin-only `message_removal` and writes this into `message.body`, so a party reading the
 * table directly — which 0020's read policy lets them do, column by column — gets this and not
 * what was said. `test/moderation.test.ts` holds the migration's literal equal to this constant.
 * The page still renders from `removed_at` rather than trusting the body, so the two sources
 * would have to disagree in the same direction for a removed message to show its old text.
 */
export const REMOVED_MESSAGE_NOTE = "Removed by the club admin";

/** What a message row renders as: its body, or the removal notice when the admin removed it. */
export function messageText(m: { body: string; removed_at: string | null }): { text: string; removed: boolean } {
  return m.removed_at ? { text: REMOVED_MESSAGE_NOTE, removed: true } : { text: m.body, removed: false };
}

/** What a closed thread says, so the page and its test agree on one sentence. */
export const THREAD_CLOSED_NOTE =
  "This thread has closed — it stays here to read, but no more messages can be sent.";

/**
 * Whether a message may be sent, and why not when it may not (AC 2, AC 5). Every refusal the
 * send action can decide for itself, in one pure function.
 *
 * IT IS A FUNCTION RATHER THAN THREE `if`s IN THE ACTION because a review found that the
 * seven-day close had exactly one enforcement point — the action, since RLS cannot express
 * elapsed time — and no test of it: deleting the guard left the whole suite green, because
 * nothing referenced `sendMessage` and `thread-view.test.ts` only called the pure helper
 * directly. A Server Action cannot be rendered or easily invoked in a unit test, so the
 * durable repair is to put the DECISION somewhere a test can reach and leave the action to
 * apply it. `sendMessageRefusal` returning null is the only route to an insert.
 *
 * The body is checked here too, so all three refusals have one home; 0020's check constraint
 * remains the boundary that a direct POST cannot bypass.
 */
export function sendMessageRefusal(
  input: { body: string; startsAt: string },
  now: Date,
): "empty" | "too_long" | "closed" | null {
  const body = input.body.trim();
  if (body.length === 0) return "empty";
  if (body.length > MESSAGE_BODY_MAX) return "too_long";
  if (!threadIsOpen(input.startsAt, now)) return "closed";
  return null;
}

/** The refusals the send action can hand back, as the form explains them (AC 2). */
export function explainMessageRefusal(reason: string): string {
  switch (reason) {
    case "too_long":
      return "That message is too long — 2,000 characters is the limit.";
    case "empty":
      return "Write something first.";
    case "closed":
      return THREAD_CLOSED_NOTE;
    case "refused":
      return "The database refused that. Only the two people matched on this post can send messages here.";
    default:
      return "That could not be sent.";
  }
}

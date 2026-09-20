import { KIND_ANSWER } from "./answer";
import { KIND_CONFIRMED, KIND_MORNING_OF } from "./confirm";
import { KIND_ERROR } from "./error";
import { KIND_INVITE } from "./invite";
import { KIND_MATCH } from "./match";
import { KIND_MESSAGE } from "./message";
import { KIND_RUNG_EMAIL } from "./rung";

/**
 * Every `notification_log.kind` that is an ATTEMPT on the email provider — the rows that count
 * against Resend's 100/day, whether the provider accepted or refused. One list, so the stores
 * that ask "how many have we sent today" agree with each other (fan-out finding on #37: the match
 * store's list stopped at three kinds, the message store's at four, and the confirm store's
 * comment claimed to match both). Skips and no-address rows are not attempts and are not here.
 *
 * `src/notify/store.ts` cannot be the home for this: it imports `server-only`, so no test can
 * read it. `kinds.test.ts` holds this list to the modules' own constants.
 *
 * The rung store's `rung_email`-only count is a recorded deferral from #33 and deliberately not
 * moved onto this list here.
 *
 * `error` joined on #43, and it is the second kind here addressed to nobody in the club — the
 * owner's OWNER_EMAIL inbox. It belongs for the list's own reason rather than by analogy: an
 * error report is a send on Resend's account like any other, and left off this list it would be
 * both free of the cap AND invisible to the cap every other sender reads, so a bad Sunday could
 * spend the club's day on error mail without a single count moving.
 */
export const EMAIL_ATTEMPT_KINDS: readonly string[] = [
  KIND_RUNG_EMAIL,
  KIND_ANSWER,
  KIND_MATCH,
  KIND_MESSAGE,
  KIND_MORNING_OF,
  KIND_CONFIRMED,
  KIND_INVITE,
  KIND_ERROR,
];

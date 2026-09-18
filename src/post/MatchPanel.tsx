import type { ReactNode } from "react";
import { matchRole, statusLabel, type MatchControls, type MatchRow, type SettableStatus } from "./match-view";

/**
 * How a matched post reads (story #21 AC 5). To a party — the skipper or the accepted crew —
 * it says 'Matched' and shows the other's name, email and phone (if given). To everyone else
 * it says the boat is crewed, with both names, and nothing more — the test beside this file
 * hands it a contact row with a bystander as viewer and asserts neither the email nor the
 * phone reaches the HTML. Names are public already (person, 0002); contact is what a match
 * reveals, and only to its two parties.
 *
 * And since story #37, what became of the match: 'Confirmed', 'Sailed' or 'Did not show',
 * shown to everyone who can see the match — the crew's own row included, because nothing is
 * hidden from them (AC 4) — plus the buttons that move it, to the one party the window is open
 * for (`matchControls`, match-view.ts). The forms themselves are the page's: this component
 * takes a renderer rather than importing the Server Action, so it stays renderable without a
 * request, the way CandidateList takes its Accept form.
 */

export type Contact = { email: string; phone: string | null };

/** A form that sets the match's status — the page supplies it (the action needs a request). */
export type StatusForm = (status: SettableStatus, label: string) => ReactNode;

const NO_CONTROLS: MatchControls = { confirm: false, record: false };

export function MatchPanel({
  match,
  viewerId,
  names,
  contact,
  controls = NO_CONTROLS,
  statusForm,
}: {
  match: MatchRow;
  viewerId: string;
  /** display_name by person id, for the two parties. */
  names: ReadonlyMap<string, string>;
  /** The counterparty's contact row as the viewer read it through RLS — null for a non-party. */
  contact: Contact | null;
  /** Which buttons this viewer gets now. Default none, so a panel rendered without a clock offers nothing. */
  controls?: MatchControls;
  statusForm?: StatusForm;
}) {
  const role = matchRole(match, viewerId);
  const skipper = names.get(match.skipper_id) ?? "the skipper";
  const crew = names.get(match.crew_id) ?? "the crew";
  const label = statusLabel(match.status);
  if (role === "other") {
    return (
      <p data-status="matched" data-role="other" data-match-status={match.status}>
        <strong>Crewed.</strong> {skipper} is sailing with {crew}.
        {label && <> {label}.</>}
      </p>
    );
  }
  const otherId = role === "skipper" ? match.crew_id : match.skipper_id;
  const other = role === "skipper" ? crew : skipper;

  // What became of it, in the viewer's own terms.
  let outcome: string | null = null;
  switch (match.status) {
    case "confirmed":
      outcome = role === "crew" ? "You confirmed you're sailing." : `${crew} confirmed they're sailing.`;
      break;
    case "sailed":
      outcome = role === "crew" ? "The skipper recorded that you sailed." : `You recorded that ${crew} sailed.`;
      break;
    case "no_show":
      outcome = role === "crew" ? "The skipper recorded a no-show against this match." : `You recorded that ${crew} did not show.`;
      break;
  }

  return (
    <section data-status="matched" data-role={role} data-match-status={match.status}>
      <p>
        <strong>Matched.</strong> You are sailing with <a href={`/profile/${otherId}`}>{other}</a>.
      </p>
      {outcome && (
        <p data-outcome={match.status}>
          <strong>{label}.</strong> {outcome}
        </p>
      )}
      {controls.confirm && statusForm && (
        <p data-controls="confirm">
          It&apos;s race day — the skipper wants to know by breakfast. {statusForm("confirmed", "Confirm I'm sailing")}
        </p>
      )}
      {role === "crew" && match.status === "accepted" && !controls.confirm && (
        <p data-controls="confirm-later">You&apos;ll be asked to confirm on the morning of the race.</p>
      )}
      {controls.record && statusForm && (
        <p data-controls="record">
          After the race: {statusForm("sailed", "Sailed")} {statusForm("no_show", "Did not show")}
        </p>
      )}
      <dl data-contact={otherId} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.25rem 1rem" }}>
        <dt>Email</dt>
        <dd>{contact ? <a href={`mailto:${contact.email}`}>{contact.email}</a> : <em>not available</em>}</dd>
        <dt>Phone</dt>
        <dd>{contact?.phone ? <a href={`tel:${contact.phone}`}>{contact.phone}</a> : <em>not given</em>}</dd>
      </dl>
      {/*
        The way into the thread (story #35). It sits here rather than on the board because a
        party reaches a match through its post, and this panel is the only place that already
        knows the viewer is a party. Without this link the thread is reachable only by typing
        the URL — a feature that ships unreachable is the documented-is-not-installed shape.
      */}
      <p>
        <a href={`/post/${match.post_id}/thread`} data-thread-link={match.post_id}>
          Messages
        </a>{" "}
        — sort out which dock and what time here.
      </p>
    </section>
  );
}

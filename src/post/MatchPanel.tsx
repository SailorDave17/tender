import { matchRole, type MatchRow } from "./match-view";

/**
 * How a matched post reads (story #21 AC 5). To a party — the skipper or the accepted crew —
 * it says 'Matched' and shows the other's name, email and phone (if given). To everyone else
 * it says the boat is crewed, with both names, and nothing more — the test beside this file
 * hands it a contact row with a bystander as viewer and asserts neither the email nor the
 * phone reaches the HTML. Names are public already (person, 0002); contact is what a match
 * reveals, and only to its two parties.
 */

export type Contact = { email: string; phone: string | null };

export function MatchPanel({
  match,
  viewerId,
  names,
  contact,
}: {
  match: MatchRow;
  viewerId: string;
  /** display_name by person id, for the two parties. */
  names: ReadonlyMap<string, string>;
  /** The counterparty's contact row as the viewer read it through RLS — null for a non-party. */
  contact: Contact | null;
}) {
  const role = matchRole(match, viewerId);
  const skipper = names.get(match.skipper_id) ?? "the skipper";
  const crew = names.get(match.crew_id) ?? "the crew";
  if (role === "other") {
    return (
      <p data-status="matched" data-role="other">
        <strong>Crewed.</strong> {skipper} is sailing with {crew}.
      </p>
    );
  }
  const otherId = role === "skipper" ? match.crew_id : match.skipper_id;
  const other = role === "skipper" ? crew : skipper;
  return (
    <section data-status="matched" data-role={role}>
      <p>
        <strong>Matched.</strong> You are sailing with <a href={`/profile/${otherId}`}>{other}</a>.
      </p>
      <dl data-contact={otherId} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.25rem 1rem" }}>
        <dt>Email</dt>
        <dd>{contact ? <a href={`mailto:${contact.email}`}>{contact.email}</a> : <em>not available</em>}</dd>
        <dt>Phone</dt>
        <dd>{contact?.phone ? <a href={`tel:${contact.phone}`}>{contact.phone}</a> : <em>not given</em>}</dd>
      </dl>
    </section>
  );
}

import { ratingLabel } from "./profile";

/**
 * How a person's profile reads — their own and anyone else's. Pure markup over data, so the
 * one thing that matters about it is tested from its rendered HTML: another person's view
 * carries no phone (story #18 AC 2, "assert absence from the HTML, not hidden").
 *
 * Two layers keep the phone private and each is tested on its own. The database hands a page
 * another person's contact row only to a matched counterparty (0008's select policy — self or
 * counterparty; test/person.test.ts, test/match.test.ts), so `phone` here is null for every
 * viewer but the owner and their match. This component then renders a phone only for the owner
 * whatever it is handed, so the counterparty's phone is shown where the match is — the post
 * page, MatchPanel — and never here. ProfileCard.test.tsx hands it a phone with a stranger as
 * viewer and asserts the digits are not in the output.
 */

export type ProfileView = {
  id: string;
  display_name: string;
  rating: number | null;
  any_hull: boolean;
  hulls: readonly string[];
};

export function hullsText(p: Pick<ProfileView, "any_hull" | "hulls">): string {
  return p.any_hull ? "Any hull" : p.hulls.join(", ");
}

export function ProfileCard({
  person,
  phone,
  viewerId,
}: {
  person: ProfileView;
  phone: string | null;
  viewerId: string;
}) {
  const own = viewerId === person.id;
  return (
    <dl data-profile={person.id} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.25rem 1rem" }}>
      <dt>Name</dt>
      <dd>{person.display_name}</dd>
      <dt>Competence</dt>
      <dd>{ratingLabel(person.rating)}</dd>
      <dt>Will sail</dt>
      <dd>{hullsText(person)}</dd>
      {own && (
        <>
          <dt>Phone</dt>
          <dd>{phone ?? <em>not given</em>}</dd>
        </>
      )}
    </dl>
  );
}

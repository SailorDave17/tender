/**
 * What a match means to whoever is looking at it (story #21 AC 5). Pure, so the three views —
 * the skipper's, the crew's, everyone else's — are decided once here and tested from the
 * rendered HTML in MatchPanel.test.tsx rather than inferred from a page.
 *
 * The database is the first layer: person_contact's select policy (0008) hands a page the
 * counterparty's row for a party and zero rows for anyone else. This module and MatchPanel are
 * the second: a page that somehow holds a contact row still renders it only to a party, so a
 * later wider read cannot leak here by accident — the same two-layer shape as ProfileCard.
 */

export type MatchRow = {
  id: string;
  post_id: string;
  skipper_id: string;
  crew_id: string;
  accepted_at: string;
};

export type MatchRole = "skipper" | "crew" | "other";

export function matchRole(match: Pick<MatchRow, "skipper_id" | "crew_id">, viewerId: string): MatchRole {
  if (viewerId === match.skipper_id) return "skipper";
  if (viewerId === match.crew_id) return "crew";
  return "other";
}

/** The person a party is matched with; null for anyone who is not a party. */
export function counterpartyOf(match: Pick<MatchRow, "skipper_id" | "crew_id">, viewerId: string): string | null {
  switch (matchRole(match, viewerId)) {
    case "skipper":
      return match.crew_id;
    case "crew":
      return match.skipper_id;
    default:
      return null;
  }
}

/** The refusals acceptAnswer can send back, as the page explains them. */
export function explainAcceptRefusal(reason: string): string {
  switch (reason) {
    case "matched":
      return "This need already has a match — the first acceptance stands.";
    case "refused":
      return "The database refused that. Only the boat's owner can accept, and only someone with a live answer on this post.";
    default:
      return "That could not be saved.";
  }
}

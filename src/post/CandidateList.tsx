import type { CandidateRow } from "@/board/post-view";
import { hullsText } from "@/profile/ProfileCard";
import { ratingLabel } from "@/profile/profile";

/**
 * The skipper's view of who is available for their post's date (story #19 AC 5, owner
 * decision B): every available crew, best rung first, each coloured by their rung with the
 * rung number in text beside it, and the ones the ladder has not reached marked 'not yet
 * notified'. Name, competence and hull willingness only — the test beside this file hands it
 * rows that carry an email and a phone and asserts neither reaches the HTML. Contact is
 * revealed by a match (#21), never by a list.
 */

export type CandidatePerson = {
  id: string;
  display_name: string;
  rating: number | null;
  any_hull: boolean;
  hulls: readonly string[];
};

export function RungBadge({ rung, colour }: { rung: 1 | 2 | 3; colour: { name: string; hex: string } }) {
  return (
    <span
      data-rung={rung}
      style={{
        display: "inline-block",
        padding: "0.1rem 0.5rem",
        borderRadius: "999px",
        background: colour.hex,
        color: "#fff",
        fontSize: "0.85rem",
        fontWeight: 600,
      }}
    >
      Rung {rung} · {colour.name}
    </span>
  );
}

export function CandidateList({
  rows,
  people,
}: {
  rows: readonly CandidateRow[];
  people: ReadonlyMap<string, CandidatePerson>;
}) {
  if (rows.length === 0) return <p data-candidates="0">Nobody has marked this day available yet.</p>;
  return (
    <ol data-candidates={rows.length} style={{ listStyle: "none", padding: 0, display: "grid", gap: "0.5rem" }}>
      {rows.map((r) => {
        const p = people.get(r.id);
        return (
          <li key={r.id} data-candidate={r.id} data-notified={r.notified} style={{ display: "flex", gap: "0.75rem", alignItems: "baseline", flexWrap: "wrap" }}>
            <RungBadge rung={r.rung} colour={r.colour} />
            <span style={{ flex: 1 }}>
              <a href={`/profile/${r.id}`}>{p?.display_name ?? "Someone"}</a> — {ratingLabel(p?.rating)},{" "}
              {p ? hullsText(p).toLowerCase() : "any hull"}
            </span>
            {!r.notified && <em>not yet notified</em>}
          </li>
        );
      })}
    </ol>
  );
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { raceIcs } from "./race-ics";

/**
 * Everything raceIcs() needs about one match, read in one place for both of its callers
 * (story #34): the match email, as the service role (src/notify/store.ts), and the download
 * route, as the signed-in person (src/app/match/[id]/race.ics/route.ts). One query, two
 * clients — so the file a crew gets attached and the file either party downloads cannot be
 * built from different reads.
 *
 * As the person, every read here is one RLS already allows a signed-in member: the match on a
 * post they can read (0008), the post and its boat (0006), the race date (0004, published
 * only), a display name (0002), the club's name (0002's column grant). Deciding that the reader
 * is a PARTY to the match is not RLS's job here — a match is readable by every member, by
 * design — and is raceIcsForViewer()'s, below.
 *
 * As the service role, post / boat / race_date / person are 0010's grants and match is 0018's.
 * `club` carries no service_role grant in any migration: the hosted project grants service_role
 * ALL on it (measured in 0016's header), which the invite store's read of `club.invite_code`
 * already relies on. The local stack needs the hand grant the overlay's recipe names.
 */

export type RaceIcsInputs = {
  matchId: string;
  postId: string;
  skipperId: string;
  crewId: string;
  acceptedAt: string;
  skipperName: string | null;
  boatClass: string;
  note: string;
  startsAt: string;
  clubName: string | null;
};

type One<T> = T | T[] | null;
const one = <T>(v: One<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

export async function readRaceIcsInputs(client: SupabaseClient, matchId: string): Promise<RaceIcsInputs | null> {
  const { data: m, error: mErr } = await client
    .from("match")
    .select("id, post_id, skipper_id, crew_id, accepted_at")
    .eq("id", matchId)
    .maybeSingle();
  if (mErr) throw new Error(`read match for ics: ${mErr.message}`);
  if (!m) return null;

  const { data: p, error: pErr } = await client
    .from("post")
    .select("note, boat:boat_id (class), race_date:race_date_id (starts_at)")
    .eq("id", m.post_id)
    .maybeSingle();
  if (pErr) throw new Error(`read post for ics: ${pErr.message}`);
  if (!p) return null;
  const boat = one(p.boat as One<{ class: string }>);
  const date = one(p.race_date as One<{ starts_at: string }>);
  if (!boat || !date) return null;

  const { data: person, error: nErr } = await client.from("person").select("display_name").eq("id", m.skipper_id).maybeSingle();
  if (nErr) throw new Error(`read skipper name for ics: ${nErr.message}`);

  const { data: club, error: cErr } = await client.from("club").select("name").limit(1).maybeSingle();
  if (cErr) throw new Error(`read club name for ics: ${cErr.message}`);

  return {
    matchId: m.id,
    postId: m.post_id,
    skipperId: m.skipper_id,
    crewId: m.crew_id,
    acceptedAt: m.accepted_at,
    skipperName: person?.display_name ?? null,
    boatClass: boat.class,
    note: p.note ?? "",
    startsAt: date.starts_at,
    clubName: club?.name ?? null,
  };
}

/** The match URL the file carries: the post page, where MatchPanel is (#33's owner decision). */
export function matchUrl(siteUrl: string, postId: string): string {
  return `${siteUrl.replace(/\/$/, "")}/post/${postId}`;
}

/** Render the inputs. Throws where raceIcs() does — a blank name or club counts as unrenderable. */
export function renderRaceIcs(inputs: RaceIcsInputs, siteUrl: string): string {
  return raceIcs(
    { id: inputs.matchId, acceptedAt: inputs.acceptedAt, skipperName: inputs.skipperName ?? "", url: matchUrl(siteUrl, inputs.postId) },
    { boatClass: inputs.boatClass, note: inputs.note },
    { startsAt: inputs.startsAt },
    { name: inputs.clubName ?? "" },
  );
}

/**
 * The download route's one decision (AC 2): the file for the match's skipper or crew, and null —
 * a 404 — for anyone else, a signed-out request included. Null for a match that is not there
 * too, so a third party cannot tell "not yours" from "does not exist".
 */
export function raceIcsForViewer(viewerId: string | null, inputs: RaceIcsInputs | null, siteUrl: string): string | null {
  if (!viewerId || !inputs) return null;
  if (viewerId !== inputs.skipperId && viewerId !== inputs.crewId) return null;
  return renderRaceIcs(inputs, siteUrl);
}

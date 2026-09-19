import { type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { raceIcsForViewer, readRaceIcsInputs } from "@/calendar/read";
import { ICS_CONTENT_TYPE, ICS_FILENAME } from "@/calendar/race-ics";

/**
 * GET /match/[id]/race.ics — the race as a calendar file, for either party to the match (story
 * #34, AC 2). The crew also gets it attached to the match email; the skipper's copy of that email
 * carries none, so this route is the skipper's way to the same file.
 *
 * Read as the signed-in person, and 404 for anyone who is neither the skipper nor the crew —
 * signed out, a third member, or a match id that does not exist, all alike, so the answer says
 * nothing about whether the match is there. `/match` is deliberately not a gated prefix
 * (src/auth/gate.ts): a redirect to /join would be a different answer for a real id than for a
 * made-up one.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return notFound();

  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return notFound();

  const inputs = await readRaceIcsInputs(client, id);
  const body = raceIcsForViewer(user.id, inputs, request.nextUrl.origin);
  if (body === null) return notFound();

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": ICS_CONTENT_TYPE,
      "Content-Disposition": `attachment; filename="${ICS_FILENAME}"`,
      "Cache-Control": "private, no-store",
    },
  });
}

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });
}

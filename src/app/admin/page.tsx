import { notFound, redirect } from "next/navigation";
import { lastTickLabel } from "@/engine/tick";
import { supabaseServer } from "@/lib/supabase/server";
import { rotateInviteCode } from "./actions";

export const dynamic = "force-dynamic";

/**
 * /admin — the club's invite code, and the one button that replaces it (story #16).
 *
 * The proxy has already sent anyone with no session to /join. A signed-in non-admin gets a
 * 404 (AC 2): the page exists for one person, and to everyone else it does not exist. The code
 * is read through current_invite_code() (0003) as the signed-in admin — the column itself is
 * withheld from every client role, and the function refuses a non-admin with 42501, so the
 * database decides twice what the 404 decided once.
 *
 * Rotate is two taps on purpose, both plain HTML forms: a GET that shows the confirmation
 * (?confirm=rotate), then the POST that rotates. A leaked code is what this page exists to
 * stop, and a mis-tap that rotates it locks out whoever was half-way through joining with the
 * old one — so the one-action rotation the charter asks for is one CONFIRMED action.
 *
 * Since #25 it also carries the ladder clock's pulse. That is the only reason `tick_run` (0012)
 * exists: a tick that never ran and a tick that ran and found nothing to do are the same
 * observation from inside the app — no email, no changed row — so without a stamp the clock's
 * death is silent for as long as nobody notices posts failing to widen. A missing row reads as
 * "never", which is the honest answer before the first tick and, after #26 wires the schedulers,
 * the loudest thing on the page.
 */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ confirm?: string; rotated?: string; error?: string }>;
}) {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/join");
  const { data: me } = await client.from("person").select("is_admin").eq("id", user.id).maybeSingle();
  if (!me?.is_admin) notFound();

  const { data: code, error: readError } = await client.rpc("current_invite_code");
  // 0012's one row, or none before the first tick. maybeSingle() so "never ticked" is a value
  // rather than an error — and note that a non-admin would read zero rows for a different
  // reason, which is why nothing but this admin-only page reads the table (0012's header).
  const { data: tick } = await client.from("tick_run").select("last_at").maybeSingle();
  const { confirm, rotated, error } = await searchParams;

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "32rem" }}>
      <h1>Admin</h1>
      <p>
        <a href="/board">Back to the board</a> · <a href="/admin/dates">Race dates</a>
      </p>

      <h2>Ladder clock</h2>
      <p>
        Last tick <strong data-last-tick>{lastTickLabel(tick ? new Date(tick.last_at) : null, new Date())}</strong>.
        The clock widens an untaken post to amber 48 h before the race and to red at 24 h, and
        emails the crew it reaches. It should run every 15 minutes; a number climbing past that
        means it has stopped.
      </p>

      <h2>Invite code</h2>
      <p>
        New people join at <code>/join</code> with this code. Rotating it stops the old code
        working immediately; anyone who has already signed in is unaffected.
      </p>
      {readError ? (
        <p role="alert">Could not read the invite code: {readError.message}</p>
      ) : (
        <p>
          Current code: <strong data-invite-code>{code as string}</strong>
        </p>
      )}
      {rotated && <p role="status">The invite code was replaced. Hand out the new one above.</p>}
      {error && <p role="alert">The code was not rotated: the database refused the change.</p>}

      {confirm === "rotate" ? (
        <form action={rotateInviteCode} style={{ display: "grid", gap: "0.75rem" }}>
          <p>
            <strong>Replace the invite code?</strong> The current code stops working the moment you
            confirm, including for anyone who has it but has not joined yet.
          </p>
          <input type="hidden" name="confirmed" value="yes" />
          <div style={{ display: "flex", gap: "0.75rem" }}>
            <button type="submit" data-confirm-rotate>
              Yes, rotate it
            </button>
            <a href="/admin">Cancel</a>
          </div>
        </form>
      ) : (
        <form method="get" action="/admin">
          <input type="hidden" name="confirm" value="rotate" />
          <button type="submit" data-rotate>
            Rotate the invite code
          </button>
        </form>
      )}
    </main>
  );
}

import { notFound, redirect } from "next/navigation";
import { suspendedSince } from "@/moderation/suspension";
import { installSummary, type InstallRow } from "@/push/install";
import { supabaseServer } from "@/lib/supabase/server";
import { liftSuspension, suspendPerson } from "./actions";

export const dynamic = "force-dynamic";

/**
 * /admin/people — who has notifications switched on (story #29 AC 6).
 *
 * THIS PAGE IS AN INSTRUMENT, not an administrative screen. ADR 007 bets that push from an
 * installed PWA is what makes a two-sided board work at ~10 crewed boats, and it names its own
 * kill condition: *fewer than half the first cohort installed two weeks after invitation*, at
 * which point push becomes best-effort and the email rule tightens. Story #32 is the one that
 * reads the number and calls it. Without this page that trigger has no instrument, and a bet with
 * an unmeasurable kill condition is not a bet — it is a hope.
 *
 * The count comes from `push_install_status()` (0013) rather than from a table read, and that is
 * a privacy decision rather than a convenience. A subscription endpoint is a capability URL:
 * whoever holds it can push to that phone. So no client role may read anyone else's row — an
 * admin's own client included — and the function returns a COUNT per person and never an
 * endpoint. It refuses a non-admin with 42501, so the 404 below and the database say no twice.
 *
 * Since #36 it also carries suspension: suspend a person, lift it. The writes are the admin's
 * own inserts and deletes on `suspension` (0023), decided by RLS, so the 404 and the database
 * say no twice here as well.
 */
export default async function AdminPeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string; error?: string }>;
}) {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/join");
  const { data: me } = await client.from("person").select("is_admin").eq("id", user.id).maybeSingle();
  if (!me?.is_admin) notFound();

  const [{ data: status, error }, { data: people }, suspensionRead] = await Promise.all([
    client.rpc("push_install_status"),
    client.from("person").select("id, display_name").order("display_name"),
    // Since #36: every suspension, which 0023 lets the admin (and only the admin) read in full.
    client.from("suspension").select("person_id, suspended_at"),
  ]);
  const suspended = suspendedSince(suspensionRead.data);
  const { done, error: actionError } = await searchParams;

  const devices = new Map((((status ?? []) as { person_id: string; devices: number }[]) ?? []).map((r) => [r.person_id, r.devices]));
  const rows: InstallRow[] = ((people ?? []) as { id: string; display_name: string }[]).map((p) => ({
    id: p.id,
    name: p.display_name,
    devices: devices.get(p.id) ?? 0,
  }));
  const summary = installSummary(rows);

  return (
    <main data-measure="wide">
      <h1>People</h1>
      <p>
        <a href="/admin">Back to admin</a> · <a href="/board">The board</a>
      </p>

      {error ? (
        <p role="alert">Could not read the install status: {error.message}</p>
      ) : (
        <>
          <h2>Notifications</h2>
          <p>
            <strong data-install-count>
              {summary.installed} of {summary.total}
            </strong>{" "}
            crew have notifications switched on{summary.total > 0 ? ` (${summary.percent}%)` : ""}.
          </p>
          <p style={{ fontSize: "0.875rem" }}>
            ADR 007&rsquo;s bet is that push is what reaches a crew on a Saturday night. Its kill
            condition is fewer than half the first cohort two weeks after invitation — this is the
            number that reads it, and story #32 is where it gets called.
          </p>

          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Person</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Notifications</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-person={r.id}>
                  <td style={{ padding: "0.25rem 0" }}>
                    <a href={`/profile/${r.id}`}>{r.name}</a>
                  </td>
                  {/* The device count, not the endpoints — a crew with a phone and a tablet reads 2. */}
                  <td style={{ padding: "0.25rem 0" }} data-devices={r.devices}>
                    {r.devices > 0 ? `On (${r.devices} ${r.devices === 1 ? "device" : "devices"})` : "Off"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* Story #36 AC 4 — a section of its own rather than a column in the table above, so a
          failed install-status read (which hides that table) never hides the suspend control. */}
      <h2>Suspension</h2>
      <p style={{ fontSize: "0.875rem" }}>
        A suspended person can still sign in and read everything, but cannot post, answer or send
        messages until you lift it. Nothing they have already written is hidden. They see one line
        saying so on the board.
      </p>
      {done === "suspended" && <p role="status">Suspended.</p>}
      {done === "lifted" && <p role="status">Suspension lifted.</p>}
      {actionError && <p role="alert">That did not go through: the database refused it.</p>}
      {suspensionRead.error ? (
        <p role="alert">Could not read who is suspended: {suspensionRead.error.message}</p>
      ) : (
        <ul data-suspension-list style={{ listStyle: "none", padding: 0, display: "grid", gap: "0.5rem" }}>
          {((people ?? []) as { id: string; display_name: string }[]).map((p) => {
            const since = suspended.get(p.id);
            return (
              <li key={p.id} data-suspension={p.id} data-suspended={Boolean(since)} style={{ display: "flex", gap: "0.75rem", alignItems: "baseline" }}>
                <span style={{ flex: 1 }}>
                  {p.display_name}
                  {since && (
                    <small>
                      {" "}
                      — suspended since{" "}
                      {new Date(since).toLocaleDateString("en-US", { timeZone: "America/New_York", dateStyle: "medium" })}
                    </small>
                  )}
                </span>
                {since ? (
                  <form action={liftSuspension}>
                    <input type="hidden" name="person_id" value={p.id} />
                    <button type="submit" data-lift={p.id}>
                      Lift
                    </button>
                  </form>
                ) : p.id === user.id ? (
                  <small>you</small>
                ) : (
                  <form action={suspendPerson}>
                    <input type="hidden" name="person_id" value={p.id} />
                    <button type="submit" data-suspend={p.id}>
                      Suspend
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

import { notFound, redirect } from "next/navigation";
import { installSummary, type InstallRow } from "@/push/install";
import { supabaseServer } from "@/lib/supabase/server";

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
 */
export default async function AdminPeoplePage() {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/join");
  const { data: me } = await client.from("person").select("is_admin").eq("id", user.id).maybeSingle();
  if (!me?.is_admin) notFound();

  const [{ data: status, error }, { data: people }] = await Promise.all([
    client.rpc("push_install_status"),
    client.from("person").select("id, display_name").order("display_name"),
  ]);

  const devices = new Map((((status ?? []) as { person_id: string; devices: number }[]) ?? []).map((r) => [r.person_id, r.devices]));
  const rows: InstallRow[] = ((people ?? []) as { id: string; display_name: string }[]).map((p) => ({
    id: p.id,
    name: p.display_name,
    devices: devices.get(p.id) ?? 0,
  }));
  const summary = installSummary(rows);

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "40rem" }}>
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
    </main>
  );
}

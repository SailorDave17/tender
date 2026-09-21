import { notFound, redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { INVITE_MAX } from "@/notify/invite";
import { decodeInviteReport, type InviteReport } from "@/notify/invite-report";
import { sendInvitesAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * /admin/invite — paste addresses, send each one the invite code (story #31).
 *
 * The gate is /admin's, for the same reasons: the proxy has sent anyone with no session to /join,
 * and a signed-in non-admin gets a 404 rather than a refusal, because the page exists for one
 * person and to everyone else it does not exist. The action re-checks that independently and has
 * to (see its docstring) — this 404 is the UI's answer, not the authorization.
 *
 * ONE TAP, NOT TWO, which is the opposite of the rotate button one screen up, and deliberate:
 * rotating the code is destructive and irreversible for whoever holds the old one, while sending
 * an invite to somebody who was going to be invited anyway is the outcome the admin came here for.
 * What protects against a mis-paste is the REPORT — every address is named back, so a wrong one is
 * visible immediately — plus the already-a-member skip, which makes re-sending the same list
 * harmless.
 *
 * The code itself is never rendered on this page. The admin does not need to see it to send it,
 * /admin shows it a click away, and a screen that both displays the code and is used with somebody
 * looking over your shoulder is the leak the rotate button exists to clean up after.
 */
export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<{ report?: string; error?: string }>;
}) {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/join");
  const { data: me } = await client.from("person").select("is_admin").eq("id", user.id).maybeSingle();
  if (!me?.is_admin) notFound();

  const { report: encoded, error } = await searchParams;
  const report = decodeInviteReport(encoded);
  // A `?report=` that will not decode is a truncated or hand-edited URL, not a send that failed.
  // Saying so is better than rendering an empty report, which reads as "nothing was sent".
  const unreadable = encoded !== undefined && report === null;

  return (
    <main data-measure="wide">
      <h1>Invite people</h1>
      <p>
        <a href="/admin">Back to admin</a> · <a href="/board">The board</a>
      </p>
      <p>
        Paste up to {INVITE_MAX} email addresses. Each one gets the join link, the current invite
        code and the steps to add Tender to a phone&rsquo;s home screen. Anyone already a member is
        skipped.
      </p>

      {error === "refused" && (
        <p role="alert" data-invite-error>
          Nothing was sent: the invites could not be prepared. Try again, and if it keeps happening
          the code or the club row may be unreadable.
        </p>
      )}
      {unreadable && (
        <p role="alert" data-invite-error>
          The report could not be read. The invites may well have been sent — check the addresses
          before sending again.
        </p>
      )}

      <form action={sendInvitesAction} style={{ display: "grid", gap: "0.75rem" }}>
        <label htmlFor="addresses">
          Addresses — one per line, or separated by commas
        </label>
        <textarea
          id="addresses"
          name="addresses"
          rows={8}
          required
          data-invite-addresses
          style={{ fontFamily: "inherit", fontSize: "1rem", padding: "0.5rem" }}
        />
        <button type="submit" data-invite-send>
          Send the invites
        </button>
      </form>

      {report && <Report report={report} />}
    </main>
  );
}

/**
 * What happened, per address. Every list is rendered when it is non-empty and omitted when it is
 * not, so the screen after a clean send of six addresses says one thing and nothing else.
 *
 * The refusal comes FIRST when there is one: it is the only case where the lists below it describe
 * a send that did not happen, and a reader who skims from the top must not read "6 already
 * members" as "and the rest went out".
 */
function Report({ report }: { report: InviteReport }) {
  const { sent, refused, members, malformed, duplicates, refusal } = report;

  return (
    <section data-invite-report style={{ marginTop: "1.5rem" }}>
      <h2>What happened</h2>

      {refusal && (
        <p role="alert" data-invite-refusal={refusal.reason}>
          {refusal.reason === "cap" ? (
            <>
              <strong>Nothing was sent.</strong> Today&rsquo;s email allowance would not cover the
              list — {refusal.fits === 0 ? "none" : `only ${refusal.fits}`} would fit. The allowance
              resets overnight; send{" "}
              {refusal.fits === 0 ? "them tomorrow" : `up to ${refusal.fits} now and the rest tomorrow`}.
            </>
          ) : refusal.reason === "too_many" ? (
            <>
              <strong>Nothing was sent.</strong> That is more than {refusal.max} addresses. Send it
              in two batches.
            </>
          ) : (
            <>
              <strong>Nothing was sent.</strong> No email address could be read in what was pasted.
            </>
          )}
        </p>
      )}

      {sent.length > 0 && (
        <>
          <h3 data-invite-sent-count={sent.length}>
            Invited ({sent.length})
          </h3>
          <ul>
            {sent.map((email) => (
              <li key={email}>{email}</li>
            ))}
          </ul>
        </>
      )}

      {members.length > 0 && (
        <>
          <h3>Already members ({members.length}) — not sent</h3>
          <ul data-invite-members>
            {members.map((email) => (
              <li key={email}>{email}</li>
            ))}
          </ul>
        </>
      )}

      {refused.length > 0 && (
        <>
          <h3>Not delivered ({refused.length})</h3>
          <p>The mail provider refused these. Check the address and try again.</p>
          <ul data-invite-refused>
            {refused.map((r) => (
              <li key={r.email}>
                {r.email} — {r.error}
              </li>
            ))}
          </ul>
        </>
      )}

      {malformed.length > 0 && (
        <>
          <h3>Not an email address ({malformed.length}) — not sent</h3>
          <ul data-invite-malformed>
            {malformed.map((line, i) => (
              <li key={`${line}-${i}`}>{line}</li>
            ))}
          </ul>
        </>
      )}

      {duplicates.length > 0 && (
        <>
          <h3>Listed more than once ({duplicates.length}) — sent once</h3>
          <ul data-invite-duplicates>
            {duplicates.map((line, i) => (
              <li key={`${line}-${i}`}>{line}</li>
            ))}
          </ul>
        </>
      )}

      {sent.length === 0 && !refusal && members.length > 0 && refused.length === 0 && (
        <p role="status">Everybody on that list is already a member. No email was sent.</p>
      )}
    </section>
  );
}

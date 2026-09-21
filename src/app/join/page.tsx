import { cookies } from "next/headers";
import { RECOGNITION_COOKIE, initialMode, isRecognized } from "@/auth/recognition";
import { JoinForm } from "./JoinForm";

export const dynamic = "force-dynamic";

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; mode?: string; deleted?: string }>;
}) {
  const { error, mode, deleted } = await searchParams;
  // #123: a browser that has never signed in here opens on **Sign up**. Read before the render,
  // not after hydration, so the right tab is in the first byte of HTML and nothing flips under
  // the person this is for. `dynamic = "force-dynamic"` above is what makes that legal.
  const recognized = isRecognized((await cookies()).get(RECOGNITION_COOKIE)?.value);
  // #173: the public web client id GIS renders its button with. Read here, on the server, rather
  // than inlined into the client bundle, so a Vercel environment missing it degrades to a /join
  // with no Google option — and no sentence promising one — instead of a button that opens a
  // Google error. Not through env(): its absence is a quiet degrade, not a throw
  // (scripts/server-env.mjs says so).
  const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "28rem" }}>
      <h1>Tender</h1>
      {/* #42: where "Delete my account" lands. `partial` is the auth step having refused after the
          person's rows were gone — the data is deleted, the sign-in record is the admin's to remove. */}
      {deleted === "1" && (
        <p role="status" data-deleted>
          Your account has been deleted. Your profile, availability, answers and messages are gone;
          any race you sailed stays counted as a nameless row.
        </p>
      )}
      {deleted === "partial" && (
        <p role="alert" data-deleted="partial">
          Your data has been deleted, but your sign-in record could not be removed. The club admin
          has been told; you will not be able to use Tender in the meantime.
        </p>
      )}
      <p>
        Members sign in with their email and password{googleClientId ? ", or with Google" : ""}. New
        to Tender? Sign up with this season&apos;s invite code.
      </p>
      <JoinForm initialError={error} initialMode={initialMode(mode, recognized)} googleClientId={googleClientId} />
    </main>
  );
}

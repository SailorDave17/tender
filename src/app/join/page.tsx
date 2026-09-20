import { JoinForm } from "./JoinForm";

export const dynamic = "force-dynamic";

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; mode?: string; deleted?: string }>;
}) {
  const { error, mode, deleted } = await searchParams;
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
        Members sign in with their email and password, or with Google. New to Tender? Sign up with
        this season&apos;s invite code.
      </p>
      <JoinForm initialError={error} initialMode={mode === "signup" ? "signup" : "signin"} />
    </main>
  );
}

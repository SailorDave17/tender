import { JoinForm } from "./JoinForm";

export const dynamic = "force-dynamic";

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; mode?: string }>;
}) {
  const { error, mode } = await searchParams;
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "28rem" }}>
      <h1>Tender</h1>
      <p>
        Members sign in with their email and password, or with Google. New to Tender? Sign up with
        this season&apos;s invite code.
      </p>
      <JoinForm initialError={error} initialMode={mode === "signup" ? "signup" : "signin"} />
    </main>
  );
}

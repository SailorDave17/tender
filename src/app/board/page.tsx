import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * The board. This story ships only the signed-in shell — the proxy sends anyone without a
 * session to /join before this renders. The person's own row is read through RLS as them.
 */
export default async function BoardPage() {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  const { data: me } = user
    ? await client.from("person").select("display_name").eq("id", user.id).maybeSingle()
    : { data: null };

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "32rem" }}>
      <h1>Tender</h1>
      <p>Signed in as {me?.display_name ?? user?.email ?? "someone"}.</p>
      <p>The board arrives with the next stories.</p>
      <form action="/auth/signout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}

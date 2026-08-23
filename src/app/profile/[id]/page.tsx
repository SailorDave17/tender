import { notFound, redirect } from "next/navigation";
import { ProfileCard } from "@/profile/ProfileCard";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * /profile/[id] — how anyone's profile reads to another signed-in person (story #18 AC 2): name,
 * competence and hull willingness, never a phone. The contact row is read through RLS as the
 * viewer, which returns nothing for anyone but the owner and a matched counterparty (0008),
 * and ProfileCard withholds the phone for any viewer but the owner whatever it is handed — two
 * layers, each tested. A matched counterparty's contact is shown on the post page (story #21),
 * not here. A person opening their own id here sees their own phone, as on /profile.
 */
export default async function PersonProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/join");

  const [{ data: person }, { data: contact }] = await Promise.all([
    client
      .from("person")
      .select("id, display_name, rating, any_hull, hulls")
      .eq("id", id)
      .maybeSingle(),
    client.from("person_contact").select("phone").eq("person_id", id).maybeSingle(),
  ]);
  if (!person) notFound();

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "32rem" }}>
      <h1>{person.display_name}</h1>
      <ProfileCard person={person} phone={contact?.phone ?? null} viewerId={user.id} />
      <p>
        <a href="/board">Back to the board</a>
      </p>
    </main>
  );
}

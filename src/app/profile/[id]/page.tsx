import { notFound, redirect } from "next/navigation";
import { ProfileCard } from "@/profile/ProfileCard";
import type { Skill } from "@/profile/profile";
import { supabaseServer } from "@/lib/supabase/server";
import { SIGN_IN_URL } from "@/auth/gate";

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
  if (!user) redirect(SIGN_IN_URL);

  const [{ data: person }, { data: contact }, { data: skillRows }] = await Promise.all([
    client
      .from("person")
      .select("id, display_name, rating, skills, any_hull, hulls")
      .eq("id", id)
      .maybeSingle(),
    client.from("person_contact").select("phone").eq("person_id", id).maybeSingle(),
    client.from("skill").select("code, label, level, sort").order("sort"),
  ]);
  if (!person) notFound();

  return (
    <main>
      <h1>{person.display_name}</h1>
      <ProfileCard
        person={person}
        phone={contact?.phone ?? null}
        viewerId={user.id}
        skills={(skillRows ?? []) as Skill[]}
      />
      <p>
        <a href="/board">Back to the board</a>
      </p>
    </main>
  );
}

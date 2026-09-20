/**
 * Deleting your own account (story #42 AC 2): the person's rows first, the auth user second,
 * and never the second without the first.
 *
 * Pure over two injected effects, so the ORDER — which is the whole of the criterion — is
 * asserted by a fake that records what was called and when, rather than inferred from a route.
 *
 * WHY THIS ORDER. `person.id` references `auth.users` on delete cascade (0002), so deleting the
 * auth user alone would take the person row and everything under it — through the platform's
 * cascade, as the service role, with no check anywhere that the caller may delete this person.
 * `delete_person()` (0027) is that check: it runs as the PERSON through their cookie-bound
 * client, refuses anyone but them or an admin, deletes the PII by name, and leaves past matches
 * as nameless rows. Only once it has returned does the service role remove the sign-in record.
 * A refusal at the first step therefore leaves everything exactly as it was, auth user included.
 *
 * WHY THE SECOND STEP CAN FAIL AND WHAT THAT MEANS. If GoTrue refuses the delete after the rows
 * are gone, the person cannot use the app (no person row → `/join?error=not-invited`) but can
 * still sign in, and the club admin has an auth user to remove by hand. The result says which
 * step failed so the action can say so rather than reporting a clean deletion.
 */

export type DeleteAccountDeps = {
  /** `delete_person(person_id)` as the person. Resolves to how many matches stay anonymised. */
  deletePerson: () => Promise<{ kept: number } | { error: string }>;
  /** `auth.admin.deleteUser(id)` as the service role. */
  deleteAuthUser: () => Promise<{ error?: string }>;
};

export type DeleteAccountResult =
  | { ok: true; kept: number }
  | { ok: false; step: "person" | "auth"; reason: string };

export async function deleteAccount(deps: DeleteAccountDeps): Promise<DeleteAccountResult> {
  const person = await deps.deletePerson();
  if ("error" in person) return { ok: false, step: "person", reason: person.error };
  const auth = await deps.deleteAuthUser();
  if (auth.error) return { ok: false, step: "auth", reason: auth.error };
  return { ok: true, kept: person.kept };
}

/** The confirm checkbox's value, the one thing the form must say. The browser's `required` is not a boundary. */
export const CONFIRM_VALUE = "yes";

export function confirmed(value: FormDataEntryValue | null): boolean {
  return value === CONFIRM_VALUE;
}

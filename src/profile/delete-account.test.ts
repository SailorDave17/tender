import { describe, expect, it } from "vitest";
import { signatureOf } from "@/notify/error";
import { AUTH_USER_NOT_DELETED, confirmed, deleteAccount, partialDeletionReport } from "./delete-account";

/**
 * Story #42 AC 2: delete_person first, the auth user second, in that order — asserted by an
 * injected pair of effects that record the order they were called in. Every failure arm is
 * covered because each one is a different state of the world afterwards: a refusal at the first
 * step changed nothing; a refusal at the second left a sign-in record with no person behind it.
 */

function recorder(over: { person?: { kept: number } | { error: string }; auth?: { error?: string } } = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      deletePerson: async () => {
        calls.push("delete_person");
        return over.person ?? { kept: 2 };
      },
      deleteAuthUser: async () => {
        calls.push("auth.admin.deleteUser");
        return over.auth ?? {};
      },
    },
  };
}

describe("deleteAccount — the person's rows, then the auth user, in that order", () => {
  it("calls delete_person and then deleteUser, and reports how many matches stay anonymised", async () => {
    const r = recorder();
    const result = await deleteAccount(r.deps);
    expect(r.calls).toEqual(["delete_person", "auth.admin.deleteUser"]);
    expect(result).toEqual({ ok: true, kept: 2 });
  });

  it("a refused delete_person stops before the auth user — nothing is deleted", async () => {
    const r = recorder({ person: { error: "only the person themself or an admin may delete a person" } });
    const result = await deleteAccount(r.deps);
    expect(r.calls).toEqual(["delete_person"]);
    expect(result).toEqual({ ok: false, step: "person", reason: "only the person themself or an admin may delete a person" });
  });

  it("a refused auth delete is reported as the auth step, after the rows are gone", async () => {
    const r = recorder({ auth: { error: "User not allowed" } });
    const result = await deleteAccount(r.deps);
    expect(r.calls).toEqual(["delete_person", "auth.admin.deleteUser"]);
    expect(result).toEqual({ ok: false, step: "auth", reason: "User not allowed" });
  });
});

describe("partialDeletionReport — the telling behind /join's 'the club admin has been told' (#204)", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";

  it("names the auth user to remove and why the auth step failed", () => {
    const r = partialDeletionReport(A, "JWT issued at future");
    expect(r.name).toBe(AUTH_USER_NOT_DELETED);
    expect(r.message).toContain(`Remove auth user ${A}`);
    expect(r.message).toContain("JWT issued at future");
    expect(r.path).toBe("/profile");
  });

  it("two members' partial deletions are two signatures, so the hour's dedupe cannot swallow the second", () => {
    // The reporter sends one email per signature per hour (#43). Keyed on the action alone, the
    // second member would be told the admin knows while nobody had been told about them.
    expect(signatureOf(partialDeletionReport(A, "x"))).not.toBe(signatureOf(partialDeletionReport(B, "x")));
    // ...while one member's repeated report is one signature, which is what the dedupe is for
    expect(signatureOf(partialDeletionReport(A, "x"))).toBe(signatureOf(partialDeletionReport(A, "y")));
  });
});

describe("confirmed — the checkbox is the confirm, and only its own value counts", () => {
  it("accepts exactly the checkbox's value", () => {
    expect(confirmed("yes")).toBe(true);
  });

  it("refuses an absent field, an empty one, and any other spelling", () => {
    expect(confirmed(null)).toBe(false);
    expect(confirmed("")).toBe(false);
    expect(confirmed("on")).toBe(false);
    expect(confirmed("true")).toBe(false);
  });
});

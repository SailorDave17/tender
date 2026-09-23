import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { clientAddress, withAttemptLimit } from "@/auth/attempt-limit";
import { WRONG_CREDENTIALS, passwordSignIn, type PasswordSignInResult } from "@/auth/password";
import { rememberDevice } from "@/auth/recognition";
import { serviceAttemptStore } from "@/lib/auth/attempt-store";
import { supabaseServer } from "@/lib/supabase/server";

/** A wrong email-and-password's answer, and so the attempt limit's (#206): the two cannot differ. */
const WRONG = { status: 401, body: { message: WRONG_CREDENTIALS } } as const;

/**
 * Sign in for a returning member (#82): email + password. `signInWithPassword` returns a session
 * directly through the cookie-bound client — the session cookies are written via cookies() and
 * Next merges that store onto this response — so this path never touches /auth/callback.
 *
 * That is exactly why the person-row guard lives here as well as at the callback: with signups ON
 * a confirmed stray can hold a session, and only a person row makes it a membership.
 * `passwordSignIn` refuses a rowless session and signs it back out (AC 7); the read is scoped to
 * the caller's own id and no user is created on this path.
 *
 * The row is minted by `ensurePerson` and by nothing else, but since #99 that is reached from two
 * places rather than one — /auth/callback and the invite gate — so "minted at the callback, never
 * here" is no longer the way to say it. Never HERE is still exact: this route creates nothing.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const client = await supabaseServer();

  const attempt = () => passwordSignIn(
    { email: String(body.email ?? ""), password: String(body.password ?? "") },
    {
      authenticate: async (email, password) => {
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (error) return { error: { code: error.code, message: error.message } };
        return { userId: data.user?.id };
      },
      hasPerson: async (userId) => {
        const { data } = await client.from("person").select("id").eq("id", userId).maybeSingle();
        return Boolean(data);
      },
      signOut: async () => {
        await client.auth.signOut();
      },
    },
  );

  // #206: every failed sign-in is one 401 with one sentence, so that answer is the failure the
  // limit counts — per source address, shared with both invite gates, and per email address — and
  // the answer a caller at either limit gets without GoTrue being asked at all.
  const result = await withAttemptLimit<PasswordSignInResult>({
    gate: "signin",
    ip: clientAddress(request.headers),
    email: String(body.email ?? ""),
    store: serviceAttemptStore(),
    refusal: WRONG,
    isFailure: (r) => r.status === WRONG.status,
    attempt,
  });

  // #123: this device has now signed in, so /join opens on Sign in next time. Through the cookie
  // STORE — `signInWithPassword` above wrote the session cookies through `cookies()`, and Next
  // applies that store over this response's own Set-Cookie headers, so `res.cookies.set` would
  // vanish on exactly this path and work on every failing one. 200 only: the 403 arm has just
  // signed the session back out, and a device that was refused is not a device that signed in.
  if (result.status === 200) rememberDevice(await cookies(), request.nextUrl.protocol === "https:");

  return NextResponse.json(result.body, { status: result.status });
}

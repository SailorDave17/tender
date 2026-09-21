/**
 * Device recognition (#123): the one bit `/join` needs before it renders — has anybody ever
 * finished signing in *in this browser*?
 *
 * The screen had no recognition of any kind. `initialMode` was the else-branch of a ternary added
 * so `/join?mode=signup` could deep-link an invited member (`JoinForm`'s docblock), which made
 * **Sign in** the default for somebody who has never had a password here. Nothing chose that; it
 * is what fell out.
 *
 * **A cookie, not `localStorage`** (owner decision, 2026-09-01). `/join` is a Server Component, so
 * a cookie is readable *before* the page renders and the right tab is in the first byte of HTML.
 * `localStorage` — the house pattern for device memory, `src/install/InstallBanner.tsx` — can only
 * correct the tab after hydration, so a first-time member would watch **Sign in** paint and flip to
 * **Sign up**: the worst outcome for exactly the person this exists for. (That file also records
 * `localStorage` *throwing* rather than answering null in a browser set to block site data.)
 *
 * **Not the `sb-*` auth cookies.** They need no new state and they are cleared at sign-out, so a
 * returning member who signed out deliberately would be shown **Sign up** — the case this prevents.
 * Sign-out must therefore leave this cookie alone; `/auth/signout` does nothing to it, and
 * `test/device-recognition.test.ts` holds it to that rather than trusting the absence.
 *
 * **A marker and nothing else.** No address, no name, no identifier — a device may be shared, and
 * the only question being asked is *has anyone signed in here*, which one byte answers. The shape
 * follows `src/auth/pass.ts`, including its protocol-conditional `secure`: hard-coding `secure`
 * would make the browser drop the cookie over plain http, so recognition would silently never work
 * on a local stack while looking correct in the source.
 */

export const RECOGNITION_COOKIE = "tender_seen";

/** The whole payload. A marker carries no fact about the person, only that there was one. */
export const RECOGNITION_VALUE = "1";

/**
 * Twelve months. The club sails a season, so the gap between a member's last sign-in and their
 * next can be a whole winter — and they are precisely the person who must not be handed **Sign
 * up**. Chrome caps a cookie's life at 400 days, so this is near the longest that is honoured
 * rather than an arbitrary round number.
 */
export const RECOGNITION_MAX_AGE_S = 365 * 24 * 60 * 60;

export type Mode = "signin" | "signup";

export type RecognitionOptions = {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
};

/** `secure` is the request's own protocol, as `src/app/api/signup/google/route.ts` sets the pass. */
export function recognitionOptions(secure: boolean): RecognitionOptions {
  return { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: RECOGNITION_MAX_AGE_S };
}

/** The narrow slice of Next's cookie store this needs — so a test can hand it a Map. */
export type CookieWriter = {
  set: (name: string, value: string, options: RecognitionOptions) => unknown;
};

/**
 * Mark this device as one that has signed in. **Through the `cookies()` store, never on the
 * returned response**: Next applies the store over the response's own `Set-Cookie` headers, so a
 * cookie set on a `NextResponse` is lost whenever anything in the same request wrote through the
 * store — which every session-touching `@supabase/ssr` call does. That is the success path of all
 * three callers and only the success path, so the response form works perfectly everywhere it does
 * not matter (cairn: `nextjs-cookie-store-merges-over-the-response-2026-08-23`, found on this
 * repo's `/auth/callback`).
 *
 * One function rather than three `store.set` calls, so the three paths cannot disagree about what
 * the cookie is.
 */
export function rememberDevice(store: CookieWriter, secure: boolean): void {
  store.set(RECOGNITION_COOKIE, RECOGNITION_VALUE, recognitionOptions(secure));
}

/** Whether this request's cookies say the device has signed in before. */
export function isRecognized(value: string | undefined | null): boolean {
  return value === RECOGNITION_VALUE;
}

/**
 * Which tab `/join` opens on. The URL parameter wins **in both directions** — it is a deep link
 * somebody was sent, so it has to beat the device's memory either way — and the cookie decides
 * only when the URL says nothing.
 */
export function initialMode(mode: string | undefined | null, recognized: boolean): Mode {
  if (mode === "signup") return "signup";
  if (mode === "signin") return "signin";
  return recognized ? "signin" : "signup";
}

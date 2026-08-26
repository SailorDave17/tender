import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * The cookie-bound client for Server Components and Route Handlers. Anon key: everything it
 * reads goes through RLS as the signed-in person. PKCE is forced by @supabase/ssr, so the
 * emailed reset link carries a `code` and the callback exchanges it.
 */
export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    cookies: {
      getAll() {
        return store.getAll();
      },
      setAll(toSet) {
        try {
          for (const { name, value, options } of toSet) store.set(name, value, options);
        } catch {
          // A Server Component cannot set cookies; the proxy refreshes the session instead.
        }
      },
    },
  });
}

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

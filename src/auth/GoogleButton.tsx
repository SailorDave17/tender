"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

/**
 * *Continue with Google* on the ID-token flow (#173): Google Identity Services renders the button
 * and obtains the ID token **in the browser, on our own origin**, so the only Google screen a
 * member sees is bound to tender.madcowsailing.com — the domain a member reads at the moment they
 * are asked to trust the app, and the whole reason #77 sent this flow here. No redirect leaves this
 * origin; the token is handed to `onCredential` and the caller posts it to a server route.
 *
 * **The nonce.** *Skip nonce checks* is OFF on the provider (#70 left it off; #173 relies on it),
 * so the token must carry one. Per mount, a random value is generated here, its SHA-256 (hex —
 * the form Supabase expects the provider to have used) goes to GIS as `nonce`, and the RAW value
 * goes back to the caller beside the token, for the server to pass to `signInWithIdToken`.
 * Supabase hashes the raw value and compares it with the token's claim. A token replayed with a
 * different raw value, or with none, is refused there.
 *
 * `next/script`'s `onReady` runs after the GSI script loads AND on every later mount — the docs'
 * own Google Maps example — which is what re-initialises GIS with a fresh nonce when the member
 * switches tabs on /join. `initialize` may be called again; the last configuration wins.
 *
 * The button is Google's iframe, so it carries no `disabled` and no label of ours; the wrapper's
 * `data-google` is the probe handle. `client_id` is the public web client id — the same one the
 * Supabase provider holds, so GoTrue accepts the token's audience — inlined from
 * `NEXT_PUBLIC_GOOGLE_CLIENT_ID`. The page hides this component when that is unset.
 */

export type GoogleButtonText = "signin_with" | "signup_with" | "continue_with";

type CredentialResponse = { credential: string; select_by?: string };

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: CredentialResponse) => void;
            nonce?: string;
            ux_mode?: "popup" | "redirect";
            auto_select?: boolean;
          }) => void;
          renderButton: (
            parent: HTMLElement,
            options: {
              type?: "standard" | "icon";
              theme?: "outline" | "filled_blue" | "filled_black";
              size?: "large" | "medium" | "small";
              text?: GoogleButtonText;
              shape?: "rectangular" | "pill";
              width?: number;
              logo_alignment?: "left" | "center";
            },
          ) => void;
        };
      };
    };
  }
}

export const GSI_SCRIPT = "https://accounts.google.com/gsi/client";

/** A raw nonce and the SHA-256 hex GIS is given. The raw value never leaves this browser except to our route. */
export async function makeNonce(
  random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b),
  digest: (data: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer> = (d) => crypto.subtle.digest("SHA-256", d),
): Promise<{ raw: string; hashed: string }> {
  const bytes = random(new Uint8Array(32));
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  raw = btoa(raw);
  // `.slice()` copies onto a plain ArrayBuffer, which is what `subtle.digest` is typed to take.
  const hash = new Uint8Array(await digest(new TextEncoder().encode(raw).slice()));
  let hashed = "";
  for (const b of hash) hashed += b.toString(16).padStart(2, "0");
  return { raw, hashed };
}

export function GoogleButton({
  clientId,
  text,
  flow,
  onCredential,
}: {
  clientId: string;
  text: GoogleButtonText;
  /** Which tab this is on; lands on the wrapper as `data-google` for the probes. */
  flow: "signin" | "signup";
  onCredential: (credential: string, nonce: string) => void;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const [nonce, setNonce] = useState<{ raw: string; hashed: string } | null>(null);

  useEffect(() => {
    let live = true;
    makeNonce().then((n) => {
      if (live) setNonce(n);
    });
    return () => {
      live = false;
    };
  }, []);

  function ready() {
    const gsi = window.google?.accounts.id;
    if (!gsi || !slot.current || !nonce) return;
    gsi.initialize({
      client_id: clientId,
      callback: (r) => onCredential(r.credential, nonce.raw),
      nonce: nonce.hashed,
      ux_mode: "popup",
    });
    slot.current.replaceChildren();
    gsi.renderButton(slot.current, {
      type: "standard",
      theme: "outline",
      size: "large",
      text,
      shape: "rectangular",
      width: 300,
    });
  }

  return (
    <div data-google={flow}>
      <div ref={slot} />
      {nonce && <Script src={GSI_SCRIPT} strategy="afterInteractive" onReady={ready} />}
    </div>
  );
}

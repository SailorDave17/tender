"use client";

import { useActionState } from "react";
import { MESSAGE_BODY_MAX, explainMessageRefusal } from "./thread-view";
import type { SendState } from "@/app/post/[id]/thread/actions";

/**
 * The send box on a match's thread (story #35 AC 2).
 *
 * A CLIENT COMPONENT, AND THE ONLY ONE ON THIS PAGE (owner decision 2026-09-17). The rest of the
 * thread is a Server Component; this is a client island because `useActionState` is what Next 16
 * documents for surfacing a Server Action's validation error, and the alternative — redirecting
 * back with `?error=`, which is what /post/[id] does for its refusals — loses what the person
 * typed. Losing a 2,000-character message to a refusal about its length would be its own defect.
 *
 * So the refusal path keeps the text: the action returns `{ error, body }`, and the textarea is
 * re-seeded from `state.body` on a refusal while a success clears it (a success returns no body,
 * and `defaultValue` follows the key below).
 *
 * The cap appears here as `maxLength` AND is checked by the action AND by 0020's check
 * constraint. That is not belt-and-braces: this one is a courtesy to the person typing, the
 * action's is a civil refusal, and only the table's is a boundary — a Server Action is a POST
 * anyone can send. MESSAGE_BODY_MAX is the single source all three read (thread-view.ts).
 */

export function SendMessageForm({
  postId,
  action,
}: {
  postId: string;
  /** The bound server action: `sendMessage.bind(null, postId)` from the page. */
  action: (prev: SendState, formData: FormData) => Promise<SendState>;
}) {
  const [state, formAction, pending] = useActionState(action, { error: null });

  return (
    <form action={formAction} data-send-message={postId} style={{ marginTop: "1.5rem" }}>
      <label htmlFor="body" style={{ display: "block", marginBottom: "0.25rem" }}>
        Send a message
      </label>
      <textarea
        id="body"
        name="body"
        rows={3}
        maxLength={MESSAGE_BODY_MAX}
        required
        // Re-seeded on a refusal so the message is not lost; the key forces React to take the
        // new default rather than keeping the mounted value, which is what makes a success
        // clear the box and a refusal preserve it.
        key={state.error ?? "clear"}
        defaultValue={state.error ? (state.body ?? "") : ""}
        aria-describedby={state.error ? "send-error" : undefined}
        aria-invalid={state.error ? true : undefined}
        style={{ width: "100%", fontFamily: "inherit", fontSize: "inherit" }}
      />
      {state.error && (
        <p id="send-error" role="alert" data-error={state.error} aria-live="polite">
          {explainMessageRefusal(state.error)}
        </p>
      )}
      <button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send"}
      </button>
    </form>
  );
}

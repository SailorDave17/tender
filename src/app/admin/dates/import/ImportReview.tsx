"use client";

import { useActionState } from "react";
import { formatStartsAt, localDate } from "@/dates/race-date";
import { publishSelected } from "./actions";
import { readIcs, type UploadState } from "./upload";

/**
 * The review step between an upload and a publish (story #40, AC 2). The upload action returns
 * what it parsed; this renders it as a checklist inside a second form, and only that second
 * form's submit writes anything. A row the parser flagged unsupported is shown highlighted with
 * its box disabled, so it cannot be ticked by accident; a row whose day has already gone is
 * shown unticked, since the hand form would refuse it, but stays tickable — a mid-season import
 * legitimately carries the dates already sailed and the admin may want the record.
 *
 * Each box's value is the row itself as JSON: the file is not kept between requests, and this
 * keeps the publish action a plain form POST the database can refuse. `readPublishRow` on the
 * server is the only reader of that value.
 */
export function ImportReview({ today }: { today: string }) {
  const [state, upload, pending] = useActionState<UploadState | null, FormData>(readIcs, null);

  return (
    <>
      <form action={upload} style={{ display: "grid", gap: "0.75rem" }} data-form="upload">
        <label>
          Calendar file (.ics)
          <input name="file" type="file" accept=".ics,text/calendar" required />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "Reading…" : "Read the file"}
        </button>
      </form>

      {state?.error && <p role="alert">{state.error}</p>}

      {state && !state.error && (
        <section>
          <h2>What {state.fileName} contains</h2>
          {state.rows.length === 0 ? (
            <p data-no-rows>No race days were found in that file.</p>
          ) : (
            <form action={publishSelected} data-form="publish">
              <p>
                Tick the race days to publish. Nothing is on the board until you press the button
                below.
              </p>
              <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: "0.5rem" }}>
                {state.rows.map((row, i) => {
                  const f = formatStartsAt(row.startsAt);
                  const past = localDate(new Date(row.startsAt)) < today;
                  const unsupported = row.unsupported !== undefined;
                  return (
                    <li
                      key={`${row.line}-${i}`}
                      data-row={i}
                      data-unsupported={unsupported}
                      data-past={past}
                      style={{
                        display: "flex",
                        gap: "0.75rem",
                        alignItems: "baseline",
                        padding: "0.25rem 0.5rem",
                        background: unsupported ? "#fde8e8" : undefined,
                        borderLeft: unsupported ? "4px solid #c33" : "4px solid transparent",
                      }}
                    >
                      <input
                        type="checkbox"
                        name="row"
                        value={JSON.stringify({ startsAt: row.startsAt, title: row.title })}
                        defaultChecked={!unsupported && !past}
                        disabled={unsupported}
                        aria-label={`Publish ${row.title} on ${f.date}`}
                      />
                      <span style={{ flex: 1 }}>
                        <strong>{f.date}</strong> {f.time} — {row.title}
                        {unsupported && (
                          <em> — a repeating event (RRULE); not supported, enter each date by hand</em>
                        )}
                        {!unsupported && past && <em> — already gone</em>}
                      </span>
                      <small>line {row.line}</small>
                    </li>
                  );
                })}
              </ul>
              <button type="submit">Publish the ticked race days</button>
            </form>
          )}

          {state.problems.length > 0 && (
            <>
              <h3>Could not read</h3>
              <ul data-problems>
                {state.problems.map((p, i) => (
                  <li key={i} data-problem-line={p.line}>
                    Line {p.line}: {p.message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </>
  );
}

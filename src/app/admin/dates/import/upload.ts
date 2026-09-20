"use server";

import { parseRaceIcs, type IcsParse } from "@/dates/ics-import";

/**
 * The upload half of /admin/dates/import (story #40, AC 2): read the file, parse it, hand the
 * rows back to the review screen. **This file imports no database client on purpose** — the AC
 * says an upload alone makes zero inserts, and the strongest form of that claim is an action
 * that cannot reach the database at all. `test/ics-upload-no-db.test.ts` holds it there; the
 * publish action, which does write, is `./actions.ts`.
 *
 * It is a Server Action rather than a browser-side parse so the same parser (and the same Intl
 * data) resolves the zones as the hand form's — a browser's ICU can differ from Node's, and a
 * race day an hour off twice a year is the defect nobody reproduces.
 *
 * No admin check here, deliberately: a parse writes nothing and reveals nothing but the file the
 * caller sent. The page gates who sees the form; the database gates who can publish.
 */

export type UploadState = IcsParse & { fileName: string; error?: string };

/** A season is a few kilobytes; a megabyte is not a calendar. Not exported: a "use server"
 * module may export only async functions. */
const MAX_ICS_BYTES = 1_000_000;

export async function readIcs(_prev: UploadState | null, formData: FormData): Promise<UploadState> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { fileName: "", rows: [], problems: [], error: "Choose an .ics file first." };
  }
  if (file.size > MAX_ICS_BYTES) {
    return { fileName: file.name, rows: [], problems: [], error: "That file is too large to be a season calendar." };
  }
  const text = await file.text();
  return { fileName: file.name, ...parseRaceIcs(text) };
}

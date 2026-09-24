"use client";

import { useEffect } from "react";
import { watchDock } from "./dock";

/** Keeps `--dock` equal to the docked navigation's real height (story #217; see `./dock`). */
export function DockHeight() {
  useEffect(() => watchDock(), []);
  return null;
}

/**
 * The install rate — ADR 007's kill condition, as a pure function (story #29 AC 6).
 *
 * It is a function rather than three lines in the page for one reason: story #32's trigger is a
 * comparison against **half**, and a proportion computed inline on a page is a number nobody can
 * test at the boundary. The cases that matter are the ones a real club hits — an empty club
 * before anyone joins, and the exact half that decides whether the bet is killed — and both are
 * tested beside this file.
 *
 * Rounding is toward zero, so 49.6% reads 49 and never 50. That direction is deliberate: the
 * trigger fires *below* half, and a percentage that rounded up would report the bet as surviving
 * on a cohort where it had not. The raw counts are what #32 should read; the percentage is for a
 * person glancing at a screen.
 */

export type InstallRow = {
  id: string;
  name: string;
  /** How many devices this person has subscribed. Zero means notifications are off. */
  devices: number;
};

export type InstallSummary = {
  /** People with at least one device. Not a device count — one person with two phones is one. */
  installed: number;
  total: number;
  /** Whole per cent, rounded down. Zero when there is nobody, rather than NaN. */
  percent: number;
};

export function installSummary(rows: readonly InstallRow[]): InstallSummary {
  const total = rows.length;
  const installed = rows.filter((r) => r.devices > 0).length;
  // An empty club divides by zero. It reads 0%, which is true and is what a club sees on the day
  // it is created — the alternative is NaN rendered into the page as "NaN%".
  const percent = total === 0 ? 0 : Math.floor((installed / total) * 100);
  return { installed, total, percent };
}

/**
 * Whether ADR 007's kill condition is met: fewer than half the cohort installed.
 *
 * Exported for story #32 rather than used here — the page reports, it does not judge. Written on
 * the counts and not the percentage, because `percent` rounds and a trigger that reads a rounded
 * proportion is a trigger with a different threshold than the one anybody agreed to.
 */
export function belowHalfInstalled(summary: InstallSummary): boolean {
  // Strictly fewer than half. Exactly half does NOT fire it: the ADR says "fewer than half".
  return summary.total > 0 && summary.installed * 2 < summary.total;
}

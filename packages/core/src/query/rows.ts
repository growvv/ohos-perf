/**
 * Shared NULL normalisation for rows read out of a trace database.
 *
 * SQLite returns `null` for any column that was never written, regardless of
 * the declared type, while the query layer's interfaces declare every field
 * non-nullable. Both coercions below encode the project-wide rule: a missing
 * numeric becomes `0` and a missing string becomes `''`. Keeping one
 * implementation means the rule (and any future change to it) has exactly one
 * place to live — silent NULL/type coercion is this project's recurring defect
 * class.
 */

/**
 * Coerces a possibly-NULL numeric column to a number.
 *
 * `0` means **absent**, not a real zero: on the measured 249MB trace,
 * `process.start_ts` is NULL on all 437 rows and `thread.end_ts` on all 1231
 * rows, so consumers must not read `0` as a genuine timestamp. This mirrors
 * HapRay's `pd.to_numeric(...).fillna(0)`.
 *
 * A value that is not a finite number also becomes `0`. SQLite does not
 * enforce a declared type: a text value stored in an `INT` column would
 * otherwise come back as `NaN`, and `JSON.stringify(NaN)` is `null` — a silent
 * conversion from "wrong data" to "no data". `0` keeps the documented
 * "absent" meaning and is at least honest about having no value.
 */
export function num(value: number | null): number {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Coerces a possibly-NULL text column to a string; `''` means absent. */
export function str(value: string | null): string {
  return value == null ? '' : String(value);
}

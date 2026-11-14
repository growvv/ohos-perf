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
 */
export function num(value: number | null): number {
  return value == null ? 0 : Number(value);
}

/** Coerces a possibly-NULL text column to a string; `''` means absent. */
export function str(value: string | null): string {
  return value == null ? '' : String(value);
}

/**
 * Argument parsing for `ohos-perf trend`.
 *
 * Kept out of `program.ts` so commander can collect a repeated option without
 * the pure command layer depending on the parsing rule, and out of
 * `commands.ts` for the same reason `collect.ts` and `run.ts` exist.
 */

/**
 * Collect repeated `--label` values into one list, in the order given.
 *
 * Commander prints an option's default in `--help`, so a raw accumulator with
 * `[]` as its initial value advertises `(default: [])` — a value no user typed.
 * This returns a fresh list per parse and keeps the default out of the help
 * text by letting the caller pass `undefined` as the initial value.
 */
export function collectLabels(raw: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), raw];
}

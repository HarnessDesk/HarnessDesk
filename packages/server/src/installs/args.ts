/**
 * The arguments an agent actually starts with, where HarnessDesk knows the
 * base and the person's own row may add to it.
 *
 * Two things are true at once. The knowledge has to win the base, or a row
 * stored under an older HarnessDesk pins arguments a newer agent has
 * renamed — `gemini --experimental-acp`, deprecated in 0.58, is exactly
 * that, and correcting it is why this does not simply hand back the row.
 * But replacing the row wholesale threw away flags only the person can know
 * to pass, and some agents cannot work without one: an OpenClaw with several
 * agents configured refuses every prompt whose session key names no owner,
 * and the only way to name one is `openclaw acp --session agent:<id>:<label>`
 * — which the row could carry and the process never saw (measured against
 * openclaw 2026.8.2).
 *
 * So a row that *extends* the knowledge keeps its extension, and a row that
 * disagrees about the base is corrected. The prefix is the test; nothing
 * else tells the two apart.
 */
export const extendedArgs = (
  known: readonly string[],
  row: readonly string[] | undefined,
): string[] => {
  const extends_ =
    row !== undefined && row.length > known.length && known.every((arg, at) => row[at] === arg)
  return extends_ ? [...row] : [...known]
}

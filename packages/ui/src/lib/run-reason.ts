/** Read known host annotations in older Runs; keep their stored reasons and other prose whole. */
export const runReasonWords = (reason: string, rules: readonly { readonly id: string }[] = []): string => {
  const rule = rules.filter(one => reason.startsWith(`Rule ${one.id}: `)).sort((a, b) => b.id.length - a.id.length)[0]
  const openingProject = /The Seat for card #\d+ could not be opened:/.test(reason) && /project is unavailable|project is outside every project opened|project (?:folder|identity)|Open it first/i.test(reason)
  return (rule ? reason.slice(`Rule ${rule.id}: `.length) : reason)
    .replace(/\bLane \S+ was retained for review; its checkout and ports were kept\./g, 'Its checkout and ports were kept for review.')
    .replace(/Next: wrap this Goal, which stops this run, then fix what stopped card #(\d+) and start the flow again in a new Goal\./g, 'Next: fix what stopped card #$1, then choose Run again.')
    .replace(/Next: fix what stopped card #\d+, then choose Run again\./g, text => openingProject ? 'Next: open the project folder again, then choose Run again.' : text)
    .replace(/Next: wrap this Goal, which stops this run, and start the flow again in a new Goal; the ("[^"\n]+") card has to record its split of the files when it finishes/g, 'Next: choose Run again. The $1 card needs to record its split of the files when it finishes')
}

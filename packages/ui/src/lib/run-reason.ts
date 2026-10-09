/** Read known host annotations in older Runs; keep their stored reasons and other prose whole. */
export const runReasonWords = (reason: string, rules: readonly { readonly id: string }[] = []): string => {
  const rule = rules.filter(one => reason.startsWith(`Rule ${one.id}: `)).sort((a, b) => b.id.length - a.id.length)[0]
  return (rule ? reason.slice(`Rule ${rule.id}: `.length) : reason)
    .replace(/\bLane \S+ was retained for review; its checkout and ports were kept\./g, 'Its checkout and ports were kept for review.')
    .replace(/Next: wrap this Goal, which stops this run, then fix what stopped card #(\d+) and start the flow again in a new Goal\./g, 'Next: fix what stopped card #$1, then choose Run again.')
    .replace(/Next: wrap this Goal, which stops this run, and start the flow again in a new Goal; the ("[^"\n]+") card has to record its split of the files when it finishes/g, 'Next: choose Run again. The $1 card needs to record its split of the files when it finishes')
}

/**
 * The change between the words a person wrote their section against and the words that ship now, line by line, as the
 * lines a reader would mark: `+` added, `-` removed, two spaces unchanged. Plain text, so it needs no colour to read.
 */
export const leadRuleDiff = (from: string, to: string): string => {
  const a = from.split('\n'), b = to.split('\n')
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
  const out: string[] = []
  let i = 0, j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++ }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) out.push(`- ${a[i++]}`)
    else out.push(`+ ${b[j++]}`)
  }
  while (i < a.length) out.push(`- ${a[i++]}`)
  while (j < b.length) out.push(`+ ${b[j++]}`)
  return out.join('\n')
}

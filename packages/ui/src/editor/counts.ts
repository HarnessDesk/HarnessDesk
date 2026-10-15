/** Physical lines include their terminator: changing the final newline changes a line. */
const physicalLines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? []

export interface ChangeCounts {
  readonly added: number
  readonly removed: number
}

/** Line counts for the draft toggle, without loading the editor engine. */
export const countTextChanges = (original: string, current: string): ChangeCounts => {
  if (original === current) return { added: 0, removed: 0 }
  const before = physicalLines(original)
  const after = physicalLines(current)
  let first = 0
  let endA = before.length
  let endB = after.length
  while (first < endA && first < endB && before[first] === after[first]) first++
  while (endA > first && endB > first && before[endA - 1] === after[endB - 1]) { endA--; endB-- }
  const a = before.slice(first, endA)
  const b = after.slice(first, endB)
  // Bound work for very large replacements, as the patch renderer does.
  if (a.length * b.length > 4_000_000) return { added: b.length, removed: a.length }
  let previous = new Uint32Array(b.length + 1)
  let next = new Uint32Array(b.length + 1)
  for (const line of a) {
    for (let j = 1; j <= b.length; j++) {
      next[j] = line === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, next[j - 1]!)
    }
    ;[previous, next] = [next, previous]
    next.fill(0)
  }
  const common = previous[b.length]!
  return { added: b.length - common, removed: a.length - common }
}

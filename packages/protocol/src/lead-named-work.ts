/**
 * The work a Lead reply names in its own words, for a reply that carries no refs. The phone and the desktop both read
 * a reply this way, by this one rule, so the same reply has the same links under it on both (#2149):
 *
 * - only the titles of Teams and sessions the surface lists, never an archived one;
 * - a title must weigh at least `LEAD_NAMED_WEIGHT` (a letter weighs one, a CJK character two), so "Fix" or "build"
 *   is too common a word, and a generic title ("Untitled", "New chat") names nothing;
 * - a title more than one piece of work has is not a name, since nothing says which one the reply meant;
 * - a title is found only as whole words (a CJK character is a boundary of its own, since CJK writing puts no space
 *   between words), compared without case, accents or width, whitespace collapsed;
 * - longest title first whatever its kind, a Team before a session of the same length, then by id; never inside a
 *   longer title already found; at most `LEAD_NAMED_LIMIT` links.
 */
export interface LeadNamedWork {
  readonly kind: 'team' | 'session'
  readonly id: string
  readonly title: string
  readonly archived?: boolean
}

export const LEAD_NAMED_LIMIT = 3
export const LEAD_NAMED_WEIGHT = 6
const GENERIC = new Set(['untitled', 'new session', 'new chat', 'new team'])

const CJK: readonly (readonly [number, number])[] = [
  [0x3040, 0x30ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], [0x1100, 0x11ff], [0x3130, 0x318f],
  [0xac00, 0xd7af], [0x20000, 0x2fa1f],
]
const isCJK = (char: string | undefined): boolean => {
  const code = char?.codePointAt(0)
  return code !== undefined && CJK.some(([low, high]) => code >= low && code <= high)
}
const isWordChar = (char: string): boolean => /[\p{L}\p{N}]/u.test(char)

/** Case-, accent- and width-insensitive, whitespace collapsed. Composed again, so a CJK syllable stays one character. */
const fold = (text: string): string =>
  text.normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFC').toLowerCase().split(/\s+/u).filter(Boolean).join(' ')

const weight = (title: string): number => [...title.trim()].reduce((sum, char) => sum + (isCJK(char) ? 2 : 1), 0)
const named = (title: string): boolean => weight(title) >= LEAD_NAMED_WEIGHT && !GENERIC.has(fold(title))

/** Whether `neighbour` ends a word next to the title's `edge` character. */
const bounds = (neighbour: string | undefined, edge: string): boolean =>
  neighbour === undefined || !isWordChar(neighbour) || isCJK(neighbour) || isCJK(edge) || !isWordChar(edge)

/** The first place `title` stands in `text` as whole words, outside the ranges already taken, as code-point offsets. */
const wholeWords = (title: readonly string[], text: readonly string[], taken: readonly (readonly [number, number])[]): readonly [number, number] | null => {
  const first = title[0], last = title.at(-1)
  if (first === undefined || last === undefined) return null
  for (let at = 0; at + title.length <= text.length; at++) {
    let same = true
    for (let i = 0; i < title.length && same; i++) same = text[at + i] === title[i]
    if (!same) continue
    const end = at + title.length
    if (bounds(text[at - 1], first) && bounds(text[end], last) && !taken.some(([from, to]) => at < to && from < end)) return [at, end]
  }
  return null
}

/** The work `text` names, by the rule above: at most `LEAD_NAMED_LIMIT` items, in the order they were found. */
export const leadWorkNamedIn = (text: string, items: readonly LeadNamedWork[]): readonly LeadNamedWork[] => {
  const folded = [...fold(text)]
  if (folded.length === 0) return []
  const holders = new Map<string, number>()
  for (const item of items) holders.set(fold(item.title), (holders.get(fold(item.title)) ?? 0) + 1)
  const candidates = items
    .filter(item => item.archived !== true && named(item.title) && holders.get(fold(item.title)) === 1)
    .map(item => ({ item, title: [...fold(item.title)] }))
    .sort((a, b) => b.title.length - a.title.length || (a.item.kind === b.item.kind ? 0 : a.item.kind === 'team' ? -1 : 1) ||
      (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0))
  const out: LeadNamedWork[] = [], claimed: (readonly [number, number])[] = []
  for (const { item, title } of candidates) {
    if (out.length >= LEAD_NAMED_LIMIT) break
    const found = wholeWords(title, folded, claimed)
    if (!found || out.some(one => one.kind === item.kind && one.id === item.id)) continue
    claimed.push(found)
    out.push(item)
  }
  return out
}

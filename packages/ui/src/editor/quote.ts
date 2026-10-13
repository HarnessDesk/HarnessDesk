import { languageForPath } from './language-path'

const fenced = (path: string, text: string, lines = ''): string => {
  let longest = 2
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
  const fence = '`'.repeat(longest + 1)
  return `${path}${lines}\n${fence}${languageForPath(path) ?? ''}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}\n`
}

/** Offsets are half-open; lines are one-based and inclusive. */
export const quoteSelection = (path: string, source: string, from: number, to: number): string | null => {
  if (from < 0 || to > source.length || from >= to) return null
  const first = source.slice(0, from).split('\n').length
  const last = source.slice(0, to - 1).split('\n').length
  return fenced(path, source.slice(from, to), `:${first}${first === last ? '' : `–${last}`}`)
}

/** Rendered text has line provenance only when exactly one source substring matches. */
export const previewSelection = (path: string, source: string, text: string): string | null => {
  if (!text) return null
  const from = source.indexOf(text)
  return from !== -1 && source.indexOf(text, from + 1) === -1
    ? quoteSelection(path, source, from, from + text.length) : fenced(path, text)
}

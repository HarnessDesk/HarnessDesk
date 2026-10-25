import { basename, isAbsolute, relative } from 'node:path'

/**
 * What may leave the desk for a paired phone, one rule per kind of text. A phone is the person's own device but a
 * small one that is lost more often than a computer, so everything here errs toward showing less: a path on this
 * machine, an address, a key-shaped string and the arguments of a command are replaced rather than trusted.
 *
 * The rules are a best effort on prose. The fields built from the desk's own records (a project's folder name, an
 * agent's name, an id) are not run through them; they are built to hold nothing risky in the first place.
 */

const TITLE_LIMIT = 120
const TEXT_LIMIT = 4000

const EMAIL = /[^\s@<>()"']+@[^\s@<>()"']+\.[^\s@<>()"']+/g
const URL_WITH_REST = /\bhttps?:\/\/[^\s<>"'`)\]/?#]+[/?#][^\s<>"'`)\]]*/g
// Not after a word, a colon or a slash: `https://host/…` is a link kept whole, not a path.
const PATH = /(?<![\w:/])(?:[A-Za-z]:\\|~\/|\/)[^\s"'`)\]]*[\\/][^\s"'`)\]]*/g
const KEY = /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{12,}/g
const LONG_RUN = /\b[A-Za-z0-9+/_=-]{40,}\b/g

/** Addresses and key-shaped strings, which no kind of text may carry out. */
const withoutIdentities = (text: string): string => text.replace(EMAIL, '…').replace(KEY, '…').replace(LONG_RUN, '…')

/** A link keeps where it points and loses what follows: a path and a query can hold a token. */
const withoutLinkRests = (text: string): string => text.replace(URL_WITH_REST, link => {
  try { return `${new URL(link).origin}/…` } catch { return '…' }
})

// Paths go before the long-run rule, which would otherwise eat the middle of one and leave its ends behind. A path at
// the end of a sentence loses its stop with it otherwise: the punctuation is the sentence's, not the path's.
const redact = (text: string): string =>
  withoutIdentities(withoutLinkRests(text).replace(PATH, path => `…${/[.,;:!?]+$/.exec(path)?.[0] ?? ''}`))

const shorten = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text

/**
 * A line of free text a person typed (a title, a Team's sentence), made safe to leave the desk: paths, addresses and
 * key-shaped strings become an ellipsis, whitespace collapses to single spaces, and it is shortened.
 */
export const scrub = (text: string, limit = TITLE_LIMIT): string => shorten(redact(text).replace(/\s+/g, ' ').trim(), limit)

/**
 * The same rules for a message with lines in it: what a person or an agent said, kept as they laid it out. Trailing
 * space and runs of blank lines are the only things tidied.
 */
export const scrubText = (text: string, limit = TEXT_LIMIT): string =>
  shorten(redact(text).replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim(), limit)

/** A folder's own name. Never the path above it, and never a name that is only a home or a root. */
export const folderName = (path: string | null | undefined): string | null => {
  if (!path) return null
  const name = basename(path.replace(/[\\/]+$/, ''))
  return name === '' || name === '.' || name === '..' ? null : scrub(name, 60)
}

/** Dollars to whole cents; null where the desk does not know. */
export const money = (value: number | null | undefined): number | null =>
  value === null || value === undefined || !Number.isFinite(value) ? null : Math.round(value * 100) / 100

/** Dollars as the phone's own money: whole micro-dollars. */
export const micros = (dollars: number): { micros: number } => ({ micros: Math.round(dollars * 1_000_000) })

/**
 * Where a file is, said inside its project and never on this machine: the path from the project's folder when it is
 * under it, and the file's own name when it is not.
 */
export const projectPath = (path: string, cwd: string | null | undefined): string => {
  if (cwd && isAbsolute(path)) {
    const inside = relative(cwd, path)
    if (inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)) return scrub(inside.split('\\').join('/'), 200)
  } else if (!isAbsolute(path) && !path.split(/[\\/]/).includes('..')) {
    return scrub(path, 200)
  }
  return scrub(basename(path), 120) || 'file'
}

/**
 * A command for a line of "what it did": the program and the words that name its job, and nothing after the first
 * flag, path, quote or assignment, where arguments (and whatever secret one carries) begin.
 */
export const commandTitle = (command: string): string => {
  const first = command.split(/&&|\|\||[;|\n]/)[0] ?? ''
  const words: string[] = []
  for (const word of first.trim().split(/\s+/)) {
    if (word === '' || words.length === 3) break
    if (/^[-/~.$'"`=]/.test(word) || /[=/\\'"`$]/.test(word)) break
    words.push(word)
  }
  return scrub(words.join(' '), 60) || 'a command'
}

export interface CommandView {
  /** The command as the person is asked to approve it: the project's folder as `.`, the home folder as `~`. */
  readonly text: string
  /** False when it was cut, or could hold a secret, so nobody should be asked to approve what they cannot read. */
  readonly whole: boolean
}

const COMMAND_LIMIT = 600

/**
 * A command to approve on a phone. Unlike the lines of a work fold it is shown with its arguments, because a person
 * cannot decide on a program's name alone; what it drops is the machine: the project's folder and the home folder
 * become `.` and `~`, and an address or a key-shaped string becomes an ellipsis.
 */
export const commandForApproval = (command: string, cwd: string | null | undefined, home: string | null | undefined, hasSecret: (text: string) => boolean): CommandView => {
  if (hasSecret(command)) return { text: '', whole: false }
  let text = command
  const swap = (folder: string | null | undefined, to: string): void => {
    if (!folder || folder === '/' || folder.length < 2) return
    const trimmed = folder.replace(/[\\/]+$/, '')
    text = text.split(`${trimmed}/`).join(`${to}/`)
    text = text.replace(new RegExp(`${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s"'\`;|&)])`, 'g'), to)
  }
  swap(cwd, '.')
  swap(home, '~')
  text = withoutIdentities(text)
  return text.length <= COMMAND_LIMIT ? { text, whole: true } : { text: `${text.slice(0, COMMAND_LIMIT - 1)}…`, whole: false }
}

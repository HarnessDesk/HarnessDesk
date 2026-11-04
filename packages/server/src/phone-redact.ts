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
// Require nonempty segments, and exclude regex syntax. URLs and regex literals are protected tokens below.
const PATH = /(?<![\w:/])(?:[A-Za-z]:\\[^\s"'`)<>{}\[\]\\/]+(?:\\[^\s"'`)<>{}\[\]\\/]+)+|~\/[^\s"'`)<>{}\[\]\\/]+(?:\/[^\s"'`)<>{}\[\]\\/]+)*|\/(?:[^\s"'`)<>{}\[\]\\/]+\/)+[^\s"'`)<>{}\[\]\\/]+)/g
const URL_TOKEN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`)\]]+/gi
const REGEX = /(?<![\w/])\/(?:\\.|[^\\/\r\n])+\/[dgimsuvy]*(?=[\s,);.\]}]|$)/g
const REGEX_LITERAL = new RegExp(`^(?:${REGEX.source})$`, 'i')
const ABSOLUTE_PATH = new RegExp(`^(?:${PATH.source})$`, 'i')
const TEXT_TOKEN = new RegExp(`${URL_TOKEN.source}|${REGEX.source}|${PATH.source}`, 'gi')
const CREDENTIALLED_URL = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi
const ASSIGNMENT_KEY = /\b([a-z][a-z0-9_-]*(?:[ \t]+key)?["']?[ \t]*(?:=|:(?!\/\/))[ \t]*)/gi
const ASSIGNMENT_VALUE = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:bearer|basic)[ \t]+[^\s,;"'<>)}\]]+|[^\s,;"'<>)}\]]+)/i

const SECRET_NAME = /(?:^|[_-])(?:password|passwd|pass|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|bearer|credentials?)(?:[_-]|$)/i

const withoutSecretValues = (text: string): string => {
  let at = 0, result = ''
  // Scan keys alone so an ordinary assignment cannot consume a later, nested secret.
  for (const match of text.matchAll(ASSIGNMENT_KEY)) {
    if (match.index < at) continue
    const prefix = match[0]
    const key = prefix.replace(/["' \t]*[:=][ \t]*$/, '').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[ \t]+/g, '_')
    if (!SECRET_NAME.test(key)) continue
    const value = ASSIGNMENT_VALUE.exec(text.slice(match.index + prefix.length))?.[0]
    if (!value) continue
    result += text.slice(at, match.index) + prefix + '…'
    at = match.index + prefix.length + value.length
  }
  return result + text.slice(at)
}

const KEY = /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{12,}/g
const LONG_RUN = /\b[A-Za-z0-9+/_=-]{40,}\b/g

/** Addresses and key-shaped strings, which no kind of text may carry out. */
const withoutKeyShapes = (text: string): string => text.replace(KEY, '…').replace(LONG_RUN, '…')
const withoutIdentities = (text: string): string => withoutKeyShapes(text.replace(EMAIL, '…'))

/** A link keeps where it points and loses what follows: a path and a query can hold a token. */
const withoutLinkRests = (text: string): string => text.replace(URL_WITH_REST, link => {
  try { return `${new URL(link).origin}/…` } catch { return '…' }
})

/** Preserve source syntax while redacting actual paths, credentialed URLs and named secret values. */
const redact = (text: string, cwd?: string): string => {
  const safe = withoutSecretValues(text.replace(CREDENTIALLED_URL, '$1…@'))
  let at = 0, result = ''
  for (const match of safe.matchAll(TEXT_TOKEN)) {
    result += withoutIdentities(safe.slice(at, match.index))
    const token = match[0]
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) {
      // Process the authority separately: the redacted userinfo marker is not an email address.
      const [, scheme = '', host = '', rest = ''] = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(token) ?? []
      const link = scheme + withoutKeyShapes(host) + withoutIdentities(rest)
      result += cwd ? link : withoutLinkRests(link)
    } else if (REGEX_LITERAL.test(token) && (!ABSOLUTE_PATH.test(token) || /[(=,:!&|?{;\[]\s*$/.test(safe.slice(0, match.index)) || safe[match.index + token.length] === '.')) {
      result += withoutIdentities(token)
    } else {
      const punctuation = /[.,;:!?]+$/.exec(token)?.[0] ?? ''
      const bare = punctuation ? token.slice(0, -punctuation.length) : token
      result += `${cwd ? projectPath(bare, cwd) : '…'}${punctuation}`
    }
    at = match.index + token.length
  }
  return result + withoutIdentities(safe.slice(at))
}

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

/** Transcript scrubbing with in-project absolute paths rewritten to project paths first. */
export const scrubProjectText = (text: string, cwd: string, limit = 300): string =>
  shorten(redact(text, cwd).replace(/[ \t]+$/g, ''), limit)

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
  if (path.startsWith('~/')) return scrub(path.slice(2), 200)
  if (cwd && isAbsolute(path)) {
    const inside = relative(cwd, path)
    if (inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)) return scrub(inside.split('\\').join('/'), 200)
  } else if (!isAbsolute(path) && !path.split(/[\\/]/).includes('..')) {
    return scrub(path, 200)
  }
  return scrub(basename(path), 120) || 'file'
}

const SHELL_PROGRAMS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish'])

/** Decode one quoted shell argument, without evaluating its contents or accepting trailing commands/arguments. */
const quotedScript = (argument: string): string | null => {
  if (argument[0] !== "'" && argument[0] !== '"') return null
  let quote = '', script = ''
  for (let index = 0; index < argument.length; index++) {
    const char = argument[index]!
    if (char === '\\' && quote !== "'") {
      const next = argument[index + 1]
      if (next === undefined) return null
      if (quote === '' || ['$', '`', '"', '\\', '\n'].includes(next)) {
        if (next !== '\n') script += next
        index++
      } else script += char
    } else if (quote) {
      if (char === quote) quote = ''
      else script += char
    } else if (char === "'" || char === '"') quote = char
    else if (/\s/.test(char)) return argument.slice(index).trim() === '' && script.trim() !== '' ? script : null
    else if (/[$`;&|<>()]/.test(char)) return null
    else script += char
  }
  return quote === '' && script.trim() !== '' ? script : null
}

/** A display projection only: no shell runs, and a wrapper we cannot read whole is refused. */
const unwrapPhoneCommand = (command: string): string | null => {
  let text = command.trim()
  for (let depth = 0; depth < 8; depth++) {
    const program = /^(\S+)(?:\s+|$)/.exec(text)
    if (!program || !SHELL_PROGRAMS.has(basename(program[1]!))) return text
    let rest = text.slice(program[0].length), execute = false
    for (;;) {
      const flag = /^(-[a-zA-Z]+|--login|--noprofile|--norc|--posix)(?:\s+|$)/.exec(rest)
      if (!flag) break
      rest = rest.slice(flag[0].length)
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(flag[1]!)) { execute = true; break }
    }
    if (!execute) return /(?:^|\s)-[a-zA-Z]*c[a-zA-Z]*(?:\s|$)/.test(rest) ? null : text
    const script = quotedScript(rest)
    if (script === null) return null
    text = script.trim()
  }
  return null
}

/**
 * A command for a line of "what it did": the program and the words that name its job, and nothing after the first
 * flag, path, quote or assignment, where arguments (and whatever secret one carries) begin.
 */
export const commandTitle = (command: string): string => {
  const first = (unwrapPhoneCommand(command) ?? '').split(/&&|\|\||[;|\n]/)[0] ?? ''
  const words: string[] = []
  for (const [index, raw] of first.trim().split(/\s+/).entries()) {
    const word = index === 0 && raw.includes('/') && !/^[-$'"`=]/.test(raw) && !/[='"`$]/.test(raw) ? basename(raw) : raw
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
  const script = unwrapPhoneCommand(command)
  if (script === null || hasSecret(command) || hasSecret(script) || withoutSecretValues(script) !== script || script.replace(CREDENTIALLED_URL, '$1…@') !== script) return { text: '', whole: false }
  let text = script
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

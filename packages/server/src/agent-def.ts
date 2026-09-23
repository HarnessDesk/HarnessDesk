import {
  ceilingOfPermission,
  isCeilingLevel,
  SEAT_PREFERENCE_LIMIT,
  type AgentDefinition,
  type AgentProblem,
  type CeilingLevel,
  type FlowSeat,
} from '@harnessdesk/protocol'

import { asList, asRecord, asText, isPermission, parseSeatList, problem } from './flow.js'
import { parseYaml, YamlError } from './yaml.js'

/**
 * One `AGENT.md`, parsed.
 *
 * Pure: no disk, no network, no clock. `agents.ts` finds the files and this
 * decides what they mean, the same way `flow.ts` decides and `flows.ts` acts.
 *
 * It reports problems and never throws. A listing is drawn while somebody is
 * still typing in one of these files, and one unparseable Agent must cost that
 * Agent rather than the roster.
 *
 * Every coercion is `flow.ts`'s own, imported and not copied: an Agent's
 * `prefer` is the seat form a role's `seats` is, "parsed by the same code", and
 * a private `String(…)` here is how the two formats start reading one file two
 * ways — `prefer: [[a, b]]` as the runtime "a,b" on this side and as a refusal
 * on that one.
 */

/**
 * One value or a list of them, the way a flow role reads its `seat`: a lone
 * `skills: review-checklist` is what somebody meant, and dropping it silently
 * because it lacked brackets is a quieter wrong than reading it.
 *
 * Named apart from the `asList` it calls, because the two answer different
 * questions — `asList` says whether a value *is* a list and never wraps one —
 * and one name over two contracts is a trap for whoever reaches for the wrong
 * import.
 */
const oneOrMore = (value: unknown): unknown[] =>
  asList(value) ?? (value === undefined || value === null ? [] : [value])

/** The words in a field. A map or a nested list is not a word, so it is dropped. */
const asWords = (value: unknown): string[] =>
  oneOrMore(value)
    .map((one) => (asText(one) ?? '').trim())
    .filter(Boolean)

/**
 * The fields an Agent has. The front matter is read for these and nothing else,
 * each only where the file itself sets it; any other key is named in a warning,
 * because read as nothing it fails silently — `permissions: merge` is a ceiling
 * of read, and an author who believes otherwise.
 */
const FIELDS = ['name', 'description', 'ceiling', 'permission', 'answers', 'produces', 'skills', 'prefer'] as const
type Field = (typeof FIELDS)[number]

/** Front matter opens on a line of exactly `---`, so `--- draft` opens nothing. */
const OPENS = /^---[ \t]*(?:\r?\n|$)/

/** …and closes on another one. The body between them may be empty. */
const FENCED = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/

/** What `split` found: front matter, the body under it, and how it went wrong. */
interface Split {
  readonly front: string
  readonly body: string
  /**
   * Where the front matter starts in the file, so a YAML refusal can point at
   * the line somebody has open rather than at the line of the slice.
   */
  readonly line: number
  /**
   * A fence that opened and never closed — the likeliest mistake in a file
   * edited by hand. Read as a brief it drops every field silently, a declared
   * `permission: merge` with them, and then blames the file for having no name,
   * so it is worth an error of its own rather than a wrong Agent.
   */
  readonly unclosed: boolean
}

/** Splits `---` front matter from the body. A file with neither is all body. */
const split = (source: string): Split => {
  if (!OPENS.test(source)) return { front: '', body: source, line: 1, unclosed: false }
  const fenced = FENCED.exec(source)
  if (!fenced) return { front: '', body: source, line: 1, unclosed: true }
  return { front: fenced[1] ?? '', body: source.slice(fenced[0].length), line: 2, unclosed: false }
}

export const parseAgentDefinition = (
  source: string,
  id: string,
): { agent: AgentDefinition | null; problems: AgentProblem[] } => {
  const problems: AgentProblem[] = []
  /* A byte-order mark is no character of the file. Left on, it kept the fence
     from opening, and the whole file — ceiling and seats with it — became the
     brief handed to a model as its standing order. */
  const { front, body, line, unclosed } = split(source.replace(/^\uFEFF/, ''))

  if (unclosed) {
    return {
      agent: null,
      problems: [
        problem(
          'error',
          'front matter',
          'the front matter opens with "---" and is never closed — close it with a line of "---" under the last field, because unclosed it is read as a brief and every field in it is discarded',
        ),
      ],
    }
  }

  let head: Record<string, unknown> = {}
  if (front.trim()) {
    try {
      head = asRecord(parseYaml(front)) ?? {}
    } catch (error) {
      return {
        agent: null,
        problems: [
          problem(
            'error',
            error instanceof YamlError ? `line ${error.line + line - 1}` : 'front matter',
            error instanceof Error ? error.message.replace(/^line \d+: /, '') : String(error),
          ),
        ],
      }
    }
  }

  /* Only what the file sets: never a value found through the map's prototype,
     where a field this file does not name would be read from somewhere that
     does not appear in it. */
  const field = (key: Field): unknown => (Object.hasOwn(head, key) ? head[key] : undefined)

  const brief = body.trim()
  if (!brief) {
    problems.push(problem('error', 'brief', 'an Agent is its brief: write below the front matter what this one is for'))
  }

  const named = field('name')
  const written = typeof named === 'string' ? named.trim() : ''
  const name = written || id
  if (!written) {
    problems.push(problem('warning', 'name', `no name, so this Agent is called “${id}” after its folder`))
  }

  const { ceiling, ceilingFrom } = ceilingOf(front, line, field('ceiling'), field('permission'), problems)

  /* The seat grammar has one parser, and this is not it: `parseSeatList`
     reads the compact form or the long one, per seat, both of them returning
     a refusal as a string — shared with `agent-seating-file.ts`, so a model
     id with a `/` in it, which can only be written as a map, is read the same
     way wherever an Agent's seats are written. */
  const listed = oneOrMore(field('prefer'))
  /* Refused whole rather than cut at the cap: the seats past it are ones the
     author wrote, and trying a shorter list than the file says would be the
     quiet kind of wrong. */
  if (listed.length > SEAT_PREFERENCE_LIMIT) {
    problems.push(
      problem(
        'error',
        'prefer',
        `it names ${listed.length} seats, and an Agent may name at most ${SEAT_PREFERENCE_LIMIT} — each seat that opens and is passed over costs a conversation, which an agent that cannot delete one may keep in its history, so keep the ones worth trying`,
      ),
    )
  }
  const { seats: prefer, broken } = parseSeatList(listed)
  for (const one of broken) problems.push(problem('error', `prefer[${one.index}]`, one.text))

  for (const key of Object.keys(head)) {
    if (!(FIELDS as readonly string[]).includes(key)) {
      problems.push(
        problem('warning', key, `"${key}" is not read — an Agent's fields are ${FIELDS.slice(0, -1).join(', ')} and ${FIELDS.at(-1)}`),
      )
    }
  }

  if (problems.some((one) => one.level === 'error')) return { agent: null, problems }

  const description = field('description')
  return {
    agent: {
      id,
      name,
      description: typeof description === 'string' ? description.trim() : null,
      ceiling,
      ceilingFrom,
      answers: asWords(field('answers')),
      produces: asWords(field('produces')),
      skills: asWords(field('skills')),
      prefer,
      brief,
    },
    problems,
  }
}

/** A top-level key of the front matter, as a line opens with it. */
const KEY_AT: Readonly<Record<'ceiling' | 'permission', RegExp>> = {
  ceiling: /^ceiling[ \t]*:/,
  permission: /^permission[ \t]*:/,
}

const keyLine = (front: string, first: number, key: 'ceiling' | 'permission'): number | null => {
  const at = front.split(/\r?\n/).findIndex((text) => KEY_AT[key].test(text))
  return at === -1 ? null : first + at
}

/** Read the new ceiling key, translate the legacy key, and refuse ambiguity. */
const ceilingOf = (
  front: string,
  first: number,
  written: unknown,
  legacy: unknown,
  problems: AgentProblem[],
): { readonly ceiling: CeilingLevel; readonly ceilingFrom: AgentDefinition['ceilingFrom'] } => {
  const narrowest = { ceiling: 'read' as const, ceilingFrom: 'none' as const }
  if (written !== undefined && legacy !== undefined) {
    const ceilingAt = keyLine(front, first, 'ceiling')
    const permissionAt = keyLine(front, first, 'permission')
    const ceilingLine = ceilingAt === null ? 'its front matter' : `line ${ceilingAt}`
    const permissionLine = permissionAt === null ? 'its front matter' : `line ${permissionAt}`
    problems.push(
      problem(
        'error',
        'ceiling',
        `it says both ceiling: (${ceilingLine}) and permission: (${permissionLine}) — keep one line: ceiling: is the key this app writes, and permission: is the one Agents were written with before`,
      ),
    )
    return narrowest
  }
  if (written !== undefined) {
    const word = asText(written)?.trim() ?? ''
    if (!word) {
      problems.push(problem('error', 'ceiling', 'the ceiling field is empty — write read, edit, publish or merge'))
    } else if (!isCeilingLevel(word)) {
      problems.push(problem('error', 'ceiling', `"${word}" is not a ceiling — it is read, edit, publish or merge`))
    } else {
      return { ceiling: word, ceilingFrom: 'ceiling' }
    }
    return narrowest
  }
  if (legacy !== undefined) {
    const word = asText(legacy)?.trim() ?? ''
    if (!word) {
      problems.push(problem('error', 'permission', 'the permission field is empty — write read, publish or merge'))
    } else if (!isPermission(word)) {
      problems.push(problem('error', 'permission', `"${word}" is not a permission — it is read, publish or merge`))
    } else {
      return { ceiling: ceilingOfPermission(word), ceilingFrom: 'permission' }
    }
    return narrowest
  }
  return narrowest
}

export interface CeilingEdit {
  readonly next: string
  readonly line: number
  readonly before: string | null
  readonly after: string
  readonly diff: string
}

const FENCE = /^---[ \t]*\r?$/
const CEILING_KEY = /^ceiling[ \t]*:/
const PERMISSION_KEY = /^permission[ \t]*:/
const ONE_WORD = /^permission[ \t]*:[ \t]*(?:read|publish|merge)([ \t]+#.*?)?\r?$/
const CONTINUED = /^(?:[ \t]+\S|[ \t]*-)/
const shown = (line: string): string => line.replace(/\r$/, '')

/** Build exactly one ceiling-line edit while preserving every unrelated byte. */
export const ceilingEdit = (source: string, level: CeilingLevel): CeilingEdit | { readonly refused: string } => {
  const bom = source.startsWith('﻿') ? '﻿' : ''
  const text = source.slice(bom.length)
  const eol = text.match(/\r?\n/)?.[0] ?? '\n'
  const lines = text.split(eol)
  const after = `ceiling: ${level}`
  const joined = (next: readonly string[]): string => `${bom}${next.join(eol)}`

  if (!FENCE.test(lines[0] ?? '')) {
    const next = ['---', after, '---', ...lines]
    return {
      next: joined(next),
      line: 2,
      before: null,
      after,
      diff: `@@ -1,1 +1,4 @@\n+---\n+${after}\n+---\n ${shown(lines[0] ?? '')}\n`,
    }
  }
  const close = lines.findIndex((line, index) => index > 0 && FENCE.test(line))
  if (close === -1) return { refused: 'its front matter opens with "---" and is never closed' }
  const front = lines.slice(1, close)
  const ceilingAt = front.findIndex((line) => CEILING_KEY.test(line))
  const permissionAt = front.findIndex((line) => PERMISSION_KEY.test(line))
  if (ceilingAt !== -1 && permissionAt !== -1) {
    return { refused: 'it says both ceiling: and permission: — keep one of the two lines by hand' }
  }
  if (ceilingAt !== -1) return { refused: 'it already says ceiling:, so there is nothing to update' }

  if (permissionAt === -1) {
    const next = [...lines.slice(0, close), after, ...lines.slice(close)]
    return {
      next: joined(next),
      line: close + 1,
      before: null,
      after,
      diff: `@@ -${close},2 +${close},3 @@\n ${shown(lines[close - 1] ?? '')}\n+${after}\n ${shown(lines[close] ?? '')}\n`,
    }
  }

  const at = permissionAt + 1
  const before = lines[at] ?? ''
  const word = ONE_WORD.exec(before)
  if (!word || (at + 1 < close && CONTINUED.test(lines[at + 1] ?? ''))) {
    return { refused: 'its permission: is not one plain word on one line — rewrite it by hand' }
  }
  const written = `${after}${word[1] ?? ''}`
  const next = [...lines.slice(0, at), written, ...lines.slice(at + 1)]
  const start = at - 1
  const end = Math.min(lines.length - 1, at + 1)
  const context = (from: number, to: number): string =>
    lines.slice(from, to).map((line) => ` ${shown(line)}\n`).join('')
  return {
    next: joined(next),
    line: at + 1,
    before: shown(before),
    after: written,
    diff: `@@ -${start + 1},${end - start + 1} +${start + 1},${end - start + 1} @@\n${context(start, at)}-${shown(before)}\n+${written}\n${context(at + 1, end + 1)}`,
  }
}

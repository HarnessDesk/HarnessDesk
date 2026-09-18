import {
  SEAT_PREFERENCE_LIMIT,
  type AgentDefinition,
  type AgentProblem,
  type FlowPermission,
  type FlowSeat,
} from '@harnessdesk/protocol'

import { asList, asRecord, asText, isPermission, parseSeat, problem, seatFromMap } from './flow.js'
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
  const { front, body, line, unclosed } = split(source)

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

  const brief = body.trim()
  if (!brief) {
    problems.push(problem('error', 'brief', 'an Agent is its brief: write below the front matter what this one is for'))
  }

  const written = typeof head['name'] === 'string' ? head['name'].trim() : ''
  const name = written || id
  if (!written) {
    problems.push(problem('warning', 'name', `no name, so this Agent is called “${id}” after its folder`))
  }

  let permission: FlowPermission = 'read'
  const declared = head['permission']
  if (declared !== undefined) {
    const word = asText(declared)?.trim() ?? ''
    if (!word) {
      /* `permission:` with nothing after it parses to null, and quoting "null"
         at somebody who wrote no word at all diagnoses the wrong thing. */
      problems.push(problem('error', 'permission', 'the permission field is empty — write read, publish or merge'))
    } else if (!isPermission(word)) {
      problems.push(problem('error', 'permission', `"${word}" is not a permission — it is read, publish or merge`))
    } else {
      permission = word
    }
  }

  /* The seat grammar has one parser, and this is not it: `parseSeat` reads the
     compact form and `seatFromMap` the long one, both of them returning the
     refusal as a string. A model id with a `/` in it can only be written as a
     map, which is why both forms are read here as well as in a flow. */
  const prefer: FlowSeat[] = []
  const listed = oneOrMore(head['prefer'])
  /* Refused whole rather than cut at the cap: the seats past it are ones the
     author wrote, and trying a shorter list than the file says would be the
     quiet kind of wrong. */
  if (listed.length > SEAT_PREFERENCE_LIMIT) {
    problems.push(
      problem(
        'error',
        'prefer',
        `it names ${listed.length} seats, and an Agent may name at most ${SEAT_PREFERENCE_LIMIT} — each seat that opens and is passed over leaves an empty conversation in that agent’s history, so keep the ones worth trying`,
      ),
    )
  }
  listed.forEach((one, index) => {
    const map = asRecord(one)
    const seat = map ? seatFromMap(map) : parseSeat(asText(one) ?? '')
    if (typeof seat === 'string') {
      problems.push(problem('error', `prefer[${index}]`, seat))
      return
    }
    prefer.push(seat)
  })

  if (problems.some((one) => one.level === 'error')) return { agent: null, problems }

  return {
    agent: {
      id,
      name,
      description: typeof head['description'] === 'string' ? head['description'].trim() : null,
      permission,
      answers: asWords(head['answers']),
      produces: asWords(head['produces']),
      skills: asWords(head['skills']),
      prefer,
      brief,
    },
    problems,
  }
}

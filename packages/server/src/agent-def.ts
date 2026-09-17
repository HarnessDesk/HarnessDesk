import type { AgentDefinition, AgentProblem, FlowPermission, FlowSeat } from '@harnessdesk/protocol'

import { parseSeat, seatFromMap } from './flow.js'
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
 */

const PERMISSIONS: readonly FlowPermission[] = ['read', 'publish', 'merge']

const problem = (level: 'error' | 'warning', at: string, text: string): AgentProblem => ({ level, at, text })

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/**
 * One value or a list of them, the way a flow role's `seat` is read: a lone
 * `skills: review-checklist` is what somebody meant, and dropping it silently
 * because it lacked brackets is a quieter wrong than reading it.
 */
const asList = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]

const asWords = (value: unknown): string[] => asList(value).map((one) => String(one).trim()).filter(Boolean)

/**
 * Splits `---` front matter from the body. A file with neither is all body.
 *
 * `line` is where the front matter starts in the file, so a YAML refusal can
 * point at the line somebody has open rather than at the line of the slice.
 */
const split = (source: string): { front: string; body: string; line: number } => {
  if (!source.startsWith('---')) return { front: '', body: source, line: 1 }
  const end = source.indexOf('\n---', 3)
  if (end < 0) return { front: '', body: source, line: 1 }
  const after = source.indexOf('\n', end + 1)
  return {
    front: source.slice(source.indexOf('\n', 0) + 1, end),
    body: after < 0 ? '' : source.slice(after + 1),
    line: 2,
  }
}

export const parseAgentDefinition = (
  source: string,
  id: string,
): { agent: AgentDefinition | null; problems: AgentProblem[] } => {
  const problems: AgentProblem[] = []
  const { front, body, line } = split(source)

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
    const word = String(declared).trim()
    if (!PERMISSIONS.includes(word as FlowPermission)) {
      problems.push(problem('error', 'permission', `“${word}” is not a permission: read, publish or merge`))
    } else {
      permission = word as FlowPermission
    }
  }

  /* The seat grammar has one parser, and this is not it: `parseSeat` reads the
     compact form and `seatFromMap` the long one, both of them returning the
     refusal as a string. A model id with a `/` in it can only be written as a
     map, which is why both forms are read here as well as in a flow. */
  const prefer: FlowSeat[] = []
  asList(head['prefer']).forEach((one, index) => {
    const map = asRecord(one)
    const seat = map ? seatFromMap(map) : parseSeat(String(one).trim())
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

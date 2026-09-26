import { AGENT_DESCRIPTION_LIMIT, AGENT_NAME_LIMIT, SEAT_PREFERENCE_LIMIT } from './agent.js'
import { AUTHORING_AGENT_LIMIT, type AgentFieldEdit, type AuthoringTarget, type StartContext, type WritableAuthoringTarget } from './authoring.js'
import type { ApprovalDecision } from './approval.js'
import type { FindingDecisionAction, FindingPublishAction } from './findings.js'
import { lanePreferences } from './goal.js'
import { TRIGGER_DAILY_USD_MAX, TRIGGER_ID } from './intake.js'
import type { TriggerBudget, TriggerCommentFrom, TriggerDefinition, TriggerField, TriggerOn, TriggerSource } from './intake.js'
import { CEILING_LEVELS } from './ceiling.js'
import type {
  ClientToHost,
  GitWorktreeCheckout,
  HostMethodName,
  WireError,
  WireRequest,
} from './wire.js'
import {
  arrayOf,
  isBoolean,
  isNumber,
  isObject,
  isString,
  isUnknown,
  literalUnion,
  optional,
  recordOf,
  shape,
  taggedUnion,
  ValidationError,
  type Validator,
} from './validate.js'
import type { EditorEvent } from './editor.js'
import type { FlowPermission, FlowSeat, FlowThen } from './flow.js'
import type { FlowAgentRole, FlowEvidenceGuard, FlowPolicy, FlowPolicyRole, FlowPolicyRule } from './flow-policy.js'
import type { UserContent } from './items.js'
import type { LibraryIntent, LibraryPlannedOp } from './library.js'
import { runtimeId, type RuntimeId } from './ids.js'
import type { ReviewRequest } from './runtime.js'

/**
 * Validators for messages the host accepts from a renderer.
 *
 * The host trusts nothing off the socket: even though the renderer is our own
 * code, the socket is a loopback port that other local processes can reach.
 */

export const userContentValidator: Validator<UserContent> = taggedUnion('type', {
  text: shape({
    type: literalUnion('text'),
    text: isString,
    spans: optional(
      arrayOf(
        shape({
          start: isNumber,
          end: isNumber,
          kind: literalUnion('mention', 'skill', 'file'),
          label: isString,
          path: optional(isString),
        }),
      ),
    ),
  }) as Validator<UserContent>,
  image: shape({
    type: literalUnion('image'),
    url: isString,
    name: optional(isString),
    detail: optional(literalUnion('low', 'high', 'auto')),
  }) as Validator<UserContent>,
  localImage: shape({
    type: literalUnion('localImage'),
    path: isString,
    detail: optional(literalUnion('low', 'high', 'auto')),
  }) as Validator<UserContent>,
  skill: shape({
    type: literalUnion('skill'),
    name: isString,
    path: isString,
  }) as Validator<UserContent>,
  mention: shape({
    type: literalUnion('mention'),
    name: isString,
    path: isString,
  }) as Validator<UserContent>,
})

const delivery = optional(literalUnion('inline', 'detached'))
const reviewRequestValidator: Validator<ReviewRequest> = taggedUnion('type', {
  uncommitted: shape({ type: literalUnion('uncommitted'), delivery }) as Validator<ReviewRequest>,
  baseBranch: shape({ type: literalUnion('baseBranch'), branch: isString, delivery }) as Validator<ReviewRequest>,
  commit: shape({ type: literalUnion('commit'), sha: isString, delivery }) as Validator<ReviewRequest>,
  custom: shape({ type: literalUnion('custom'), instructions: isString, delivery }) as Validator<ReviewRequest>,
})

const optionValueValidator: Validator<string | boolean> = (value, path = '') =>
  typeof value === 'string' || typeof value === 'boolean'
    ? value
    : (() => {
        throw new ValidationError(path, `expected string or boolean, got ${typeof value}`)
      })()

export const approvalDecisionValidator: Validator<ApprovalDecision> = taggedUnion('type', {
  option: shape({ type: literalUnion('option'), optionId: isString }) as Validator<ApprovalDecision>,
  answers: shape({
    type: literalUnion('answers'),
    answers: ((value: unknown, path = '') => {
      const source = isObject(value, path)
      const out: Record<string, string[]> = {}
      for (const [key, entry] of Object.entries(source)) {
        out[key] = arrayOf(isString)(entry, `${path}.${key}`)
      }
      return out
    }) as Validator<Record<string, string[]>>,
  }) as Validator<ApprovalDecision>,
  content: shape({
    type: literalUnion('content'),
    value: isUnknown,
  }) as Validator<ApprovalDecision>,
  cancel: shape({ type: literalUnion('cancel') }) as Validator<ApprovalDecision>,
})

/**
 * The library's write path crosses this socket carrying paths and file
 * content, so its shapes are validated field by field — the host re-checks
 * every path against its own location table besides, but a message that is
 * not even the right shape should not get that far.
 */
const isRuntimeId: Validator<RuntimeId> = (value, path = '') => runtimeId(isString(value, path))

/** A string with something in it. An empty id or folder names nothing, and would be read as "the default". */
const isFilled: Validator<string> = (value, path = '') => {
  const text = isString(value, path)
  if (text.trim() === '') throw new ValidationError(path, 'expected a non-empty string')
  return text
}

/** A string held to the file field's public limit before it reaches the host. */
const atMost = (limit: number, read: Validator<string> = isString): Validator<string> =>
  (value, path = '') => {
    const text = read(value, path)
    if (text.length > limit) throw new ValidationError(path, `expected at most ${limit} characters, got ${text.length}`)
    return text
  }

/**
 * A seat as a map — `{ runtime, model, effort, thinking }` — the shape a seat
 * spec parses to. Checked field by field because it is handed to the seating
 * as it arrives, and a seat's runtime is what names the conversation opened.
 */
const flowSeatValidator = shape({
  runtime: isFilled,
  model: optional(isString),
  effort: optional(isString),
  thinking: optional(isBoolean),
}) as Validator<FlowSeat>

/**
 * The permissions a seating may grant. Keyed by `FlowPermission`, so a fourth
 * permission stops this compiling rather than being refused here while every
 * file that reads the word goes on taking it.
 */
const GRANTS: Readonly<Record<FlowPermission, true>> = { read: true, publish: true, merge: true }
const grantValidator = literalUnion(...(Object.keys(GRANTS) as FlowPermission[]))

const ceilingValidator = literalUnion(...CEILING_LEVELS)

/** The seats one seating tries in the Agent's place: no more than its `prefer` may name. */
const seatListValidator: Validator<FlowSeat[]> = (value, path = '') => {
  const seats = arrayOf(flowSeatValidator)(value, path)
  if (seats.length > SEAT_PREFERENCE_LIMIT) {
    throw new ValidationError(path, `expected at most ${SEAT_PREFERENCE_LIMIT} seats, got ${seats.length}`)
  }
  return seats
}

const libraryIntentValidator: Validator<LibraryIntent> = taggedUnion('kind', {
  installSkill: shape({
    kind: literalUnion('installSkill'),
    name: isString,
    sourcePath: isString,
    targetRuntime: isRuntimeId,
  }) as Validator<LibraryIntent>,
  authorSkill: shape({
    kind: literalUnion('authorSkill'),
    name: isString,
    content: isString,
    targetRuntimes: arrayOf(isRuntimeId),
  }) as Validator<LibraryIntent>,
  syncSkill: shape({
    kind: literalUnion('syncSkill'),
    name: isString,
    sourcePath: isString,
    targetPaths: arrayOf(isString),
  }) as Validator<LibraryIntent>,
  removeCopy: shape({
    kind: literalUnion('removeCopy'),
    name: isString,
    path: isString,
  }) as Validator<LibraryIntent>,
  restoreCopy: shape({
    kind: literalUnion('restoreCopy'),
    name: isString,
    backupPath: isString,
    targetPath: isString,
  }) as Validator<LibraryIntent>,
  installMcp: shape({
    kind: literalUnion('installMcp'),
    name: isString,
    sourcePath: isString,
    targetRuntime: isRuntimeId,
  }) as Validator<LibraryIntent>,
  removeMcp: shape({
    kind: literalUnion('removeMcp'),
    name: isString,
    path: isString,
  }) as Validator<LibraryIntent>,
})

const nullableString: Validator<string | null> = (value, path = '') =>
  value === null ? null : isString(value, path)

const libraryPlannedOpValidator: Validator<LibraryPlannedOp> = shape({
  id: isString,
  kind: literalUnion('skill', 'mcp'),
  name: isString,
  action: literalUnion('create', 'update', 'replace', 'remove', 'skip', 'refuse'),
  targetPath: isString,
  targetRuntime: optional(isRuntimeId),
  preview: optional(isString),
  extraFiles: optional(arrayOf(isString)),
  reason: optional(isString),
  content: optional(isString),
  sourcePath: optional(isString),
  flat: optional(isBoolean),
  guardDigest: nullableString,
  backup: isBoolean,
}) as Validator<LibraryPlannedOp>

/** Goal writes never accept host observations or authority through an extra key. */
const goalShape = <T extends Record<string, unknown>>(
  fields: { [K in keyof T]: Validator<T[K]> },
): Validator<T> => {
  const read = shape(fields)
  return (value: unknown, path = '') => {
    const object = isObject(value, path)
    for (const key of Object.keys(object)) {
      if (!Object.hasOwn(fields, key)) throw new ValidationError(`${path}.${key}`, 'unexpected field')
    }
    return read(value, path)
  }
}

/**
 * A session's options with the fields only the host may set refused
 * outright, before any handler runs. `knownCwd` is the folder the host's own
 * record gives a reopened Seat — a caller naming one would pick where a
 * conversation opens, past the agent's listing. `attachments` is a Seat's frozen,
 * approved filter (phase 12), computed from trust and ceiling by the host
 * and never accepted from a client — present at all, even `null`, it is a
 * claim about what a conversation loads, so it is refused rather than
 * ignored. The handlers strip it as well, for a caller that is not the wire.
 */
const withoutHostOnly = <T>(read: Validator<T>): Validator<T> => (value: unknown, path = '') => {
  const object = isObject(value, path)
  for (const key of ['attachments', 'knownCwd']) {
    if (Object.hasOwn(object, key)) throw new ValidationError(`${path}.${key}`, 'set by the host only')
  }
  return read(value, path)
}

const goalId = atMost(4096, isFilled)
const goalIdentifier = atMost(200, isFilled)
const goalSentence: Validator<string> = (value, path = '') => atMost(2000, isFilled)(isString(value, path).trim(), path)
const goalInteger = (minimum: number): Validator<number> => (value, path = '') => {
  const number = isNumber(value, path)
  if (!Number.isSafeInteger(number) || number < minimum) throw new ValidationError(path, `expected a safe integer at least ${minimum}`)
  return number
}
const goalDependencies: Validator<string[]> = (value, path = '') => {
  const ids = arrayOf(goalId)(value, path)
  if (ids.length > 128) throw new ValidationError(path, 'expected at most 128 dependencies')
  return ids
}
const goalGrant = taggedUnion<import('./goal.js').SeatGrant, 'kind'>('kind', {
  permission: goalShape({ kind: literalUnion('permission'), permission: grantValidator }),
  ceiling: goalShape({ kind: literalUnion('ceiling'), level: literalUnion('read', 'edit', 'publish', 'merge') }),
})

const goalHex = (lengths: readonly number[]): Validator<string> => (value, path = '') => {
  const text = isString(value, path)
  if (!lengths.includes(text.length) || !/^[0-9a-f]+$/.test(text)) {
    throw new ValidationError(path, `expected ${lengths.join(' or ')} lowercase hexadecimal characters`)
  }
  return text
}
const wrapReason: Validator<string | null> = (value, path = '') =>
  value === null ? null : atMost(2000, isString)(value, path)
const wrapCards: Validator<import('./goal.js').WrapChoices['cards']> = (value, path = '') => {
  const cards = arrayOf(goalShape({
    id: goalInteger(1), resolution: literalUnion('finished', 'dropped'), reason: wrapReason,
  }))(value, path)
  if (cards.length > 1000) throw new ValidationError(path, 'expected at most 1000 card choices')
  if (new Set(cards.map((card) => card.id)).size !== cards.length) throw new ValidationError(path, 'expected each card once')
  return cards
}
const wrapChoices = goalShape({
  summary: atMost(4000, isString), cards: wrapCards, publicationGaps: optional(literalUnion('record')),
})
const citationPath: Validator<string> = (value, path = '') => {
  const text = atMost(4096, isFilled)(value, path)
  const parts = text.split('/')
  if (text.includes('\\') || text.startsWith('/') || /^[A-Za-z]:/.test(text) ||
      parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new ValidationError(path, 'expected a literal relative document path')
  }
  return text
}
const goalCitation = goalShape({
  goal: goalId, receipt: goalIdentifier, project: atMost(4096, isFilled), path: citationPath,
  at: goalHex([40, 64]),
})

const goalValidators = {
  'goal/list': goalShape({ root: optional(atMost(4096, isFilled)) }),
  'goal/read': goalShape({ goal: goalId }),
  'goal/create': goalShape({
    root: atMost(4096, isFilled), cwd: optional(atMost(4096, isFilled)), sentence: goalSentence,
    checkout: optional(literalUnion('shared', 'isolated')), dependsOn: optional(goalDependencies),
  }),
  'goal/update': goalShape({
    goal: goalId, revision: goalInteger(0), sentence: optional(goalSentence), dependsOn: optional(goalDependencies),
  }),
  'goal/seat': goalShape({
    goal: goalId, agent: goalIdentifier, seats: optional(seatListValidator),
    grant: optional(goalGrant), card: optional(goalInteger(1)), isolate: optional(isBoolean),
  }),
  'goal/assign': goalShape({
    goal: goalId, card: goalInteger(1),
    session: goalShape({ runtime: goalIdentifier, sessionId: goalIdentifier }),
  }),
  'goal/release': goalShape({ goal: goalId, seat: goalIdentifier }),
  'goal/preview': goalShape({ goal: goalId, choices: wrapChoices }),
  'goal/wrap': goalShape({ goal: goalId, stamp: goalHex([64]), choices: wrapChoices }),
  'goal/receipt': goalShape({ goal: goalId }),
  'goal/cite': goalShape({ goal: goalId, citation: goalCitation }),
  'goal/migration/ack': goalShape({}),
}

/** A finding id the ledger minted, never one a caller invents. */
const findingId: Validator<string> = (value, path = '') => {
  const text = isString(value, path)
  if (!/^finding-[0-9a-f-]{1,190}$/.test(text)) throw new ValidationError(path, 'expected a finding id the ledger gave it')
  return text
}
/** A read cursor: opaque to the caller, so only its shape (never its meaning) is checked here. */
const findingCursor = atMost(512, isFilled)
const findingRun = goalIdentifier
const findingRequest: Validator<string> = (value, path = '') => {
  const text = isString(value, path)
  if (text.trim() === '' || text.length > 200 || /[\u0000-\u001f]/.test(text)) {
    throw new ValidationError(path, 'expected a printable request token of 1 to 200 characters')
  }
  return text
}
const findingIds: Validator<string[]> = (value, path = '') => {
  const ids = arrayOf(findingId)(value, path)
  if (ids.length < 1 || ids.length > 200) throw new ValidationError(path, 'expected 1 to 200 findings')
  if (new Set(ids).size !== ids.length) throw new ValidationError(path, 'expected each finding once')
  return ids
}
const findingReason: Validator<string> = (value, path = '') => atMost(4096, isFilled)(value, path)
const findingDecisionAction = taggedUnion<FindingDecisionAction, 'kind'>('kind', {
  'another-round': goalShape({ kind: literalUnion('another-round') }),
  'merge-anyway': goalShape({ kind: literalUnion('merge-anyway') }),
  drop: goalShape({ kind: literalUnion('drop') }),
  'admit-exceptions': goalShape({ kind: literalUnion('admit-exceptions'), findings: findingIds }),
  'decline-exceptions': goalShape({ kind: literalUnion('decline-exceptions'), findings: findingIds }),
  adjudicate: goalShape({
    kind: literalUnion('adjudicate'), finding: findingId, state: literalUnion('open', 'repaired', 'withdrawn'),
  }),
})

const publicationKey: Validator<string> = (value, path = '') => {
  const text = isString(value, path)
  if (!/^pub-[0-9a-f]{48}$/.test(text)) throw new ValidationError(path, 'expected a posting operation key')
  return text
}
const findingPublishAction = taggedUnion<FindingPublishAction, 'kind'>('kind', {
  'post-again': goalShape({ kind: literalUnion('post-again'), key: publicationKey }),
  skip: goalShape({ kind: literalUnion('skip'), key: publicationKey, reason: findingReason }),
  backfill: goalShape({ kind: literalUnion('backfill'), stamp: goalHex([64]) }),
})

const findingValidators = {
  'finding/list': goalShape({
    goal: goalId, cursor: optional(findingCursor), filter: optional(literalUnion('all', 'open', 'blocking')),
  }),
  'finding/read': goalShape({ goal: goalId, finding: findingId, cursor: optional(findingCursor) }),
  'finding/carry': goalShape({
    goal: goalId, revision: goalInteger(0), source: goalId, receipt: goalIdentifier,
    findings: findingIds, request: findingRequest,
  }),
  'finding/publication': goalShape({ goal: goalId, revision: goalInteger(0), enabled: isBoolean }),
  'finding/run': goalShape({ goal: goalId, run: findingRun }),
  'finding/decide': goalShape({
    goal: goalId, run: findingRun, round: goalInteger(1), stamp: goalHex([64]),
    action: findingDecisionAction, reason: findingReason,
  }),
  'finding/publications': goalShape({ goal: goalId, run: findingRun }),
  'finding/publish': goalShape({ goal: goalId, run: findingRun, action: findingPublishAction }),
}

/**
 * Intake's person controls. A root is an absolute, printable path the host
 * then confines; an id is a trigger's slug; a token or cursor is at most 200
 * printable characters and means nothing here; money is finite and bounded.
 * `goalShape` refuses every other key, so an origin, grant, fact or command
 * never rides along.
 */
const triggerRoot: Validator<string> = (value, path = '') => {
  const text = isString(value, path)
  const absolute = text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\')
  if (text.length === 0 || text.length > 4096 || !absolute || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new ValidationError(path, 'expected an absolute project folder')
  }
  return text
}
const triggerId: Validator<string> = (value, path = '') => {
  const text = isString(value, path)
  if (!TRIGGER_ID.test(text)) throw new ValidationError(path, 'expected a trigger id: 1 to 64 lowercase letters, digits, - or _')
  return text
}
const triggerOpaque: Validator<string> = (value, path = '') => {
  const text = isString(value, path)
  if (text.length === 0 || text.length > 200 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new ValidationError(path, 'expected 1 to 200 printable characters')
  }
  return text
}
const triggerGoal: Validator<string> = (value, path = '') => {
  const text = isString(value, path)
  if (text.length === 0 || text.length > 64 || /[\u0000-\u001f\u007f]/.test(text)) throw new ValidationError(path, 'expected a Goal id of at most 64 characters')
  return text
}
const triggerUsd: Validator<number> = (value, path = '') => {
  const number = isNumber(value, path)
  if (!Number.isFinite(number) || number < 0 || number > TRIGGER_DAILY_USD_MAX) {
    throw new ValidationError(path, `expected a finite daily cap from 0 to ${TRIGGER_DAILY_USD_MAX} dollars`)
  }
  return number
}
const triggerValidators = {
  'trigger/list': goalShape({ root: triggerRoot }),
  'trigger/preview': goalShape({ root: triggerRoot, id: triggerId }),
  'trigger/arm': goalShape({ root: triggerRoot, id: triggerId, token: triggerOpaque }),
  'trigger/disarm': goalShape({ root: triggerRoot, id: triggerId }),
  'trigger/rebaseline': goalShape({ root: triggerRoot, id: triggerId }),
  'trigger/preferences': goalShape({}),
  'trigger/preferences/set': goalShape({ revision: goalInteger(0), paused: isBoolean, dailyUsd: triggerUsd }),
  'trigger/history': goalShape({ root: triggerRoot, id: triggerId, cursor: optional(triggerOpaque) }),
  'trigger/goal': goalShape({ goal: triggerGoal }),
}

/**
 * Authoring. A target is a kind, an origin and a slug id — never a path, an
 * environment or a grant, and `goalShape` refuses any other key. A save names
 * a project's or this person's file only: a built-in one is refused here,
 * before anything reaches the host. A digest is the 64 hex characters a read
 * answered, and a field edit carries a value the host encodes itself.
 */
const authoringAgentId: Validator<string> = (value, path = '') => {
  const text = isString(value, path)
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(text)) throw new ValidationError(path, 'expected an Agent id: 1 to 48 lowercase letters, digits or -')
  return text
}
const authoringFlowId: Validator<string> = (value, path = '') => {
  const text = isString(value, path)
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(text)) throw new ValidationError(path, 'expected a flow id: 1 to 64 lowercase letters, digits, - or _')
  return text
}
const authoringDigest = goalHex([64])
const authoringTarget = (origins: readonly ('project' | 'user' | 'builtin')[]) => taggedUnion<AuthoringTarget, 'kind'>('kind', {
  agent: goalShape({ kind: literalUnion('agent'), origin: literalUnion(...origins), id: authoringAgentId, root: optional(triggerRoot) }) as Validator<AuthoringTarget>,
  flow: goalShape({ kind: literalUnion('flow'), origin: literalUnion(...origins), id: authoringFlowId, root: triggerRoot }) as Validator<AuthoringTarget>,
  triggers: goalShape({ kind: literalUnion('triggers'), origin: literalUnion('project'), root: triggerRoot }) as Validator<AuthoringTarget>,
})
const anyAuthoringTarget = authoringTarget(['project', 'user', 'builtin'])
const writableAuthoringTarget = authoringTarget(['project', 'user']) as Validator<WritableAuthoringTarget>
const authoringWords: Validator<string[]> = (value, path = '') => {
  const words = arrayOf(atMost(200))(value, path)
  if (words.length > 64) throw new ValidationError(path, 'expected at most 64 entries')
  return words
}
const agentFieldEdit = taggedUnion<AgentFieldEdit, 'key'>('key', {
  name: goalShape({ key: literalUnion('name'), value: atMost(AGENT_NAME_LIMIT) }) as Validator<AgentFieldEdit>,
  description: goalShape({ key: literalUnion('description'), value: atMost(AGENT_DESCRIPTION_LIMIT) }) as Validator<AgentFieldEdit>,
  ceiling: goalShape({ key: literalUnion('ceiling'), value: ceilingValidator }) as Validator<AgentFieldEdit>,
  answers: goalShape({ key: literalUnion('answers'), value: authoringWords }) as Validator<AgentFieldEdit>,
  produces: goalShape({ key: literalUnion('produces'), value: authoringWords }) as Validator<AgentFieldEdit>,
  prefer: goalShape({ key: literalUnion('prefer'), value: seatListValidator }) as Validator<AgentFieldEdit>,
})
const authoringAgents: Validator<{ id: string; source: string }[]> = (value, path = '') => {
  const agents = arrayOf(goalShape({ id: authoringAgentId, source: atMost(256 * 1024) }))(value, path)
  if (agents.length > AUTHORING_AGENT_LIMIT) throw new ValidationError(path, `expected at most ${AUTHORING_AGENT_LIMIT} new Agents`)
  return agents
}
/**
 * What a start is about, as inputs only: a branch name and a diff's two ends
 * are single revision names (never an option, a range or a URL), a pull
 * request is its positive number in the project, and every root is an
 * absolute folder the host then confines. None of it is a fact the host
 * trusts: each is resolved on the host before a preview is drawn.
 */
const startRevision: Validator<string> = (value, path = '') => {
  const text = isString(value, path)
  if (text.length === 0 || text.length > 200 || !/^[\w][\w./@{}~^-]*$/.test(text) || text.includes('..') || /\^[-@]/.test(text)) {
    throw new ValidationError(path, 'expected one revision name, not an option or a range')
  }
  return text
}
const pullNumber: Validator<number> = (value, path = '') => {
  const number = isNumber(value, path)
  if (!Number.isSafeInteger(number) || number < 1 || number > 1_000_000_000) throw new ValidationError(path, 'expected a pull request number')
  return number
}
const startContext = taggedUnion<StartContext, 'kind'>('kind', {
  project: goalShape({ kind: literalUnion('project'), root: triggerRoot }) as Validator<StartContext>,
  branch: goalShape({ kind: literalUnion('branch'), root: triggerRoot, branch: startRevision }) as Validator<StartContext>,
  'pull-request': goalShape({ kind: literalUnion('pull-request'), root: triggerRoot, number: pullNumber }) as Validator<StartContext>,
  diff: goalShape({ kind: literalUnion('diff'), root: triggerRoot, from: startRevision, to: startRevision }) as Validator<StartContext>,
  'working-diff': goalShape({ kind: literalUnion('working-diff'), root: triggerRoot }) as Validator<StartContext>,
})
const startVars: Validator<Record<string, string>> = (value, path = '') => {
  const vars = recordOf(atMost(4096))(value, path)
  if (Object.keys(vars).length > 64) throw new ValidationError(path, 'expected at most 64 inputs')
  return vars
}
const startGoal = goalShape({ id: goalId, revision: goalInteger(0) })

/**
 * A shape's own policy, sent whole to be rendered as YAML. This is not a
 * second copy of the parser's semantic rules — an id that would not survive
 * being written and read back exactly (a role's `independentOf`, a rule's
 * `then.role`) is caught by `writeShape`'s own round-trip check on the host,
 * the same guard every other authoring save already relies on. What this
 * validator owns is the wire boundary: every field is the right type, and
 * every list is bounded, before that code ever sees it.
 */
const flowRoleId: Validator<string> = (value, path = '') => {
  const text = isString(value, path)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(text)) throw new ValidationError(path, 'expected an id of up to 64 letters, digits, - or _')
  return text
}
const flowWordList = <T>(limit: number, item: Validator<T>): Validator<T[]> => (value, path = '') => {
  const words = arrayOf(item)(value, path)
  if (words.length > limit) throw new ValidationError(path, `expected at most ${limit} entries`)
  return words
}
const flowThenValidator: Validator<FlowThen> = goalShape({
  role: flowRoleId,
  title: atMost(2000, isFilled),
  detail: optional(atMost(4000)),
  files: optional(flowWordList(32, atMost(500))),
}) as Validator<FlowThen>
const flowEvidenceGuardValidator: Validator<FlowEvidenceGuard> = (value, path = '') => {
  const record = isObject(value, path)
  const keys = Object.keys(record)
  if (keys.length !== 1) throw new ValidationError(path, 'expected exactly one observed fact')
  const [key] = keys as [string]
  if (key === 'check') return { check: atMost(200, isFilled)(record['check'], `${path}.check`) }
  if (key === 'ci') {
    if (record['ci'] !== 'green') throw new ValidationError(`${path}.ci`, 'expected "green"')
    return { ci: 'green' }
  }
  if (key === 'review') return { review: atMost(200, isFilled)(record['review'], `${path}.review`) }
  if (key === 'pr') {
    const pr = record['pr']
    if (pr !== 'open' && pr !== 'merged') throw new ValidationError(`${path}.pr`, 'expected open or merged')
    return { pr }
  }
  if (key === 'diff') {
    if (record['diff'] !== true) throw new ValidationError(`${path}.diff`, 'expected true')
    return { diff: true }
  }
  throw new ValidationError(path, 'expected check, ci, review, pr or diff')
}
const flowCheckValidator = goalShape({
  run: atMost(4000, isFilled),
  cwd: optional(atMost(4096)),
  timeout: goalInteger(1),
  exits: recordOf(atMost(200, isFilled)),
  otherwise: atMost(200, isFilled),
})
const flowPolicyRoleValidator: Validator<FlowPolicyRole> = (value, path = '') => {
  const record = isObject(value, path)
  const id = flowRoleId(record['id'], `${path}.id`)
  const kind = record['kind']
  if (kind === 'agent') {
    const role = goalShape({
      id: flowRoleId,
      kind: literalUnion('agent'),
      uses: flowWordList(32, authoringAgentId),
      seats: seatListValidator,
      count: optional(goalInteger(1)),
      isolate: isBoolean,
      grant: ceilingValidator,
      independentOf: flowWordList(32, flowRoleId),
      blind: optional(isBoolean),
    })(record, path) as FlowAgentRole
    return { ...role, id }
  }
  if (kind === 'check') {
    return { id, kind: 'check', check: flowCheckValidator(record['check'], `${path}.check`) } as FlowPolicyRole
  }
  if (kind === 'person') {
    return { id, kind: 'person', outcomes: flowWordList(64, atMost(200, isFilled))(record['outcomes'], `${path}.outcomes`) } as FlowPolicyRole
  }
  throw new ValidationError(`${path}.kind`, 'expected agent, check or person')
}
const flowPolicyRuleValidator: Validator<FlowPolicyRule> = goalShape({
  id: flowRoleId,
  on: flowRoleId,
  when: optional(goalShape({
    every: optional(flowWordList(64, atMost(200, isFilled))),
    any: optional(flowWordList(64, atMost(200, isFilled))),
    evidence: optional(flowWordList(32, flowEvidenceGuardValidator)),
  })),
  then: flowThenValidator,
}) as Validator<FlowPolicyRule>
const flowInputValidator = goalShape({
  id: flowRoleId,
  label: atMost(200, isFilled),
  default: optional(atMost(2000)),
})
const flowBudgetValidator = goalShape({ rounds: goalInteger(1), withoutProgress: goalInteger(1) })
/** Reserved layout metadata: opaque to this validator, and re-checked field by field on the host before it is trusted for anything. Bounded so it cannot carry an unbounded payload across the wire. */
const flowLayoutValidator: Validator<unknown> = (value, path = '') => {
  if (value === undefined || value === null) return value
  let size: number
  try {
    size = JSON.stringify(value).length
  } catch {
    throw new ValidationError(path, 'expected a plain JSON value')
  }
  if (size > 64 * 1024) throw new ValidationError(path, 'expected layout metadata under 64 KiB')
  return value
}
const flowPolicyValidator: Validator<FlowPolicy> = goalShape({
  version: ((value: unknown, path = '') => {
    if (value !== 2) throw new ValidationError(path, 'expected 2')
    return 2 as const
  }) as Validator<2>,
  name: atMost(200, isFilled),
  description: optional(atMost(4000)),
  inputs: flowWordList(64, flowInputValidator) as unknown as Validator<FlowPolicy['inputs']>,
  roles: flowWordList(64, flowPolicyRoleValidator) as unknown as Validator<FlowPolicy['roles']>,
  rules: flowWordList(256, flowPolicyRuleValidator) as unknown as Validator<FlowPolicy['rules']>,
  seed: flowThenValidator,
  messaging: literalUnion('board-only', 'members'),
  wait: goalInteger(1),
  rearm: optional(goalInteger(0)),
  budget: optional(flowBudgetValidator),
  layout: optional(flowLayoutValidator),
}) as Validator<FlowPolicy>

/**
 * Triggers. `on`, `opens` and the whole definition are validated for shape
 * and bounds only — the semantic rules (dedupe must include the subject
 * field, `again` reads only phase-8's fixed title) are `parseTriggers`'s,
 * re-checked by `writeTriggers`'s own round-trip on the host.
 */
const triggerSourceValidator: Validator<TriggerSource> = literalUnion('pull-request', 'issue', 'schedule')
const triggerFieldValidator: Validator<TriggerField> = literalUnion('pr', 'head', 'event', 'issue', 'slot')
const triggerFieldListValidator = flowWordList(5, triggerFieldValidator) as unknown as Validator<TriggerField[]>
const triggerSlug: Validator<string> = (value, path = '') => {
  const text = isString(value, path)
  if (!TRIGGER_ID.test(text)) throw new ValidationError(path, 'expected an id: 1 to 64 lowercase letters, digits, - or _')
  return text
}
const triggerOpensValidator: Validator<TriggerDefinition['opens']> = (value, path = '') => {
  const record = isObject(value, path)
  const keys = Object.keys(record)
  if (keys.length !== 1 || (keys[0] !== 'flow' && keys[0] !== 'agent')) throw new ValidationError(path, 'expected { flow: id } or { agent: id }')
  const key = keys[0] as 'flow' | 'agent'
  const id = triggerSlug(record[key], `${path}.${key}`)
  return key === 'flow' ? { flow: id } : { agent: id }
}
const triggerOnValidator: Validator<TriggerOn> = (value, path = '') => {
  const record = isObject(value, path)
  const kind = record['kind']
  if (kind === 'schedule') {
    const events = flowWordList(1, literalUnion('tick'))(record['events'], `${path}.events`)
    const everyMinutes = goalInteger(1)(record['everyMinutes'], `${path}.everyMinutes`)
    if (everyMinutes > 10080) throw new ValidationError(`${path}.everyMinutes`, 'expected at most 10080 minutes')
    return { kind: 'schedule', events: ['tick'] as const, everyMinutes }
  }
  if (kind === 'pull-request') {
    return { kind: 'pull-request', events: flowWordList(2, literalUnion('opened', 'pushed'))(record['events'], `${path}.events`) }
  }
  if (kind === 'issue') {
    return { kind: 'issue', events: flowWordList(3, literalUnion('labelled', 'closed', 'commented'))(record['events'], `${path}.events`) }
  }
  throw new ValidationError(`${path}.kind`, 'expected pull-request, issue or schedule')
}
const triggerBudgetValidator: Validator<TriggerBudget> = goalShape({
  usd: ((value: unknown, path = '') => {
    const number = isNumber(value, path)
    if (number < 0.01 || number > TRIGGER_DAILY_USD_MAX) throw new ValidationError(path, `expected 0.01 to ${TRIGGER_DAILY_USD_MAX}`)
    return number
  }) as Validator<number>,
  rounds: goalInteger(1),
  hours: ((value: unknown, path = '') => {
    const number = isNumber(value, path)
    if (number <= 0 || number > 168) throw new ValidationError(path, 'expected up to 168 hours')
    return number
  }) as Validator<number>,
  withoutProgress: goalInteger(1),
}) as Validator<TriggerBudget>
const triggerCommentFromValidator: Validator<TriggerCommentFrom> = literalUnion('me', 'collaborators', 'anyone')
const triggerDefinitionValidator: Validator<TriggerDefinition> = goalShape({
  id: triggerSlug,
  on: triggerOnValidator,
  opens: triggerOpensValidator,
  goal: triggerFieldListValidator,
  again: ((value: unknown, path = '') => (value === null || value === undefined ? null : flowThenValidator(value, path))) as Validator<FlowThen | null>,
  dedupe: triggerFieldListValidator,
  concurrency: goalInteger(1),
  forks: literalUnion('never', 'allow'),
  budget: triggerBudgetValidator,
  label: optional(flowWordList(5, atMost(50, isFilled))),
  from: optional(triggerCommentFromValidator),
}) as Validator<TriggerDefinition>
const triggerDefinitionsValidator: Validator<TriggerDefinition[]> = (value, path = '') => {
  const definitions = arrayOf(triggerDefinitionValidator)(value, path)
  if (definitions.length > 64) throw new ValidationError(path, 'expected at most 64 triggers')
  return definitions
}

const authoringValidators = {
  'authoring/read': goalShape({ target: anyAuthoringTarget }),
  'authoring/agent/patch': goalShape({
    target: ((value: unknown, path = '') => {
      const target = writableAuthoringTarget(value, path)
      if (target.kind !== 'agent') throw new ValidationError(`${path}.kind`, 'expected an Agent')
      return target
    }) as Validator<Extract<WritableAuthoringTarget, { readonly kind: 'agent' }>>,
    expected: authoringDigest,
    edit: agentFieldEdit,
  }),
  'authoring/save/preview': goalShape({
    target: writableAuthoringTarget,
    expected: ((value: unknown, path = '') => (value === null ? null : authoringDigest(value, path))) as Validator<string | null>,
    source: atMost(256 * 1024),
    agents: optional(authoringAgents),
  }),
  'authoring/save/apply': goalShape({ token: triggerOpaque }),
  'authoring/save/pending': goalShape({}),
  'authoring/save/resume': goalShape({ id: goalHex([32]) }),
  'authoring/save/discard': goalShape({ id: goalHex([32]) }),
  'authoring/start/preview': goalShape({ context: startContext, source: atMost(256 * 1024), vars: startVars, goal: optional(startGoal) }),
  'authoring/shape/render': goalShape({ policy: flowPolicyValidator }),
  'authoring/triggers/draft': goalShape({ id: triggerSlug, on: triggerSourceValidator, opens: triggerOpensValidator }),
  'authoring/triggers/render': goalShape({ definitions: triggerDefinitionsValidator }),
}

/**
 * A window's own preferences. Intake's machine state — its arms, its pause
 * and its cap — is never one of them: it has its own person-only methods,
 * so a key that could be mistaken for it is refused here.
 */
const windowPreferences: Validator<Record<string, unknown>> = (value, path = '') => {
  const patch = isObject(value, path)
  for (const key of Object.keys(patch)) {
    if (/^trigger/i.test(key) || /^intake/i.test(key)) {
      throw new ValidationError(`${path}.${key}`, 'trigger arms, pause and daily cap are set through their own controls')
    }
  }
  return patch
}

/** Read-only Insight accepts selectors, never values the host is responsible for measuring. */
const insightMillis: Validator<number> = (value, path = '') => {
  const number = isNumber(value, path)
  if (!Number.isSafeInteger(number) || number < 0) throw new ValidationError(path, 'expected a non-negative safe millisecond timestamp')
  return number
}
const insightQuery = (value: unknown, path = '') => {
  const query = goalShape({ root: atMost(4096, isFilled), from: insightMillis, to: insightMillis, runtime: optional(isString) })(value, path)
  if (query.from >= query.to) throw new ValidationError(path, 'expected from before to')
  if (query.to - query.from > 90 * 86_400_000) throw new ValidationError(path, 'expected a range of at most 90 days')
  return query
}
const insightSelector = goalShape({
  agent: goalIdentifier,
  origin: literalUnion('project', 'user', 'builtin'),
  briefDigest: nullableString,
  seat: (value: unknown, path = '') => value === null ? null : flowSeatValidator(value, path),
})
const insightGoals: Validator<string[]> = (value, path = '') => {
  const goals = arrayOf(goalId)(value, path)
  if (goals.length === 0 || goals.length > 50 || new Set(goals).size !== goals.length) {
    throw new ValidationError(path, 'expected 1 to 50 distinct Goal ids')
  }
  return goals
}
const insightCompare = (value: unknown, path = '') => {
  const object = isObject(value, path)
  const query = insightQuery({ root: object.root, from: object.from, to: object.to }, path)
  const read = goalShape({ root: atMost(4096, isFilled), from: insightMillis, to: insightMillis, runtime: optional(isString), goals: insightGoals, left: insightSelector, right: insightSelector })(value, path)
  if (query.from !== read.from || query.to !== read.to) throw new ValidationError(path, 'invalid Insight range')
  return read
}
const insightValidators = {
  'insight/goal': goalShape({ goal: goalId }),
  'insight/usage': insightQuery,
  'insight/agent': goalShape({ root: optional(atMost(4096, isFilled)), agent: goalIdentifier, origin: literalUnion('project', 'user', 'builtin') }),
  'insight/compare': insightCompare,
  'insight/order/preview': goalShape({
    root: atMost(4096, isFilled), from: insightMillis, to: insightMillis, goals: insightGoals,
    left: insightSelector, right: insightSelector, agent: goalIdentifier, origin: literalUnion('project', 'user', 'builtin'), current: optional(seatListValidator),
  }),
  'insight/order/apply': goalShape({ stamp: atMost(256, isFilled) }),
}

/**
 * Per-method params validators. A method missing from this table is rejected,
 * so the table doubles as the host's method allowlist.
 */
const provenanceRoot: Validator<string> = (value, path = '') => {
  const text = isString(value, path)
  if (!text.length || text.length > 4096 || text.includes('\x00')) {
    throw new ValidationError(path, 'expected a project root')
  }
  return text
}
const provenanceOptionalRoot: Validator<string | undefined> = (value, path = '') =>
  value === undefined ? undefined : provenanceRoot(value, path)

const provenanceShas: Validator<string[]> = (value, path = '') => {
  if (!Array.isArray(value) || value.length > 1000 || value.some((sha) =>
    typeof sha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha),
  )) {
    throw new ValidationError(path, 'expected at most 1000 full object ids')
  }
  return [...new Set(value)] as string[]
}
const provenanceSeat: Validator<string> = (value, path = '') => {
  const text = isString(value, path)
  if (!text.length || text.length > 200 || /[\x00-\x1f\x7f]/.test(text)) {
    throw new ValidationError(path, 'expected a Seat id')
  }
  return text
}

const paramsValidators: Record<HostMethodName, Validator<unknown>> = {
  'provenance/commits': shape({ root: provenanceRoot, shas: provenanceShas }),
  'provenance/status': shape({ root: provenanceOptionalRoot }),
  'provenance/capture': shape({ root: provenanceRoot, enabled: isBoolean }),
  'provenance/retry': shape({ root: provenanceRoot }),
  'provenance/seat': shape({ root: provenanceRoot, seat: provenanceSeat }),
  'lane/preferences': goalShape({}),
  'lane/list': goalShape({}),
  'lane/preferences/set': (value, path = '') => {
    try { return lanePreferences(value) }
    catch (error) { throw new ValidationError(path, error instanceof Error ? error.message : String(error)) }
  },
  'lane/release': goalShape({ lane: goalIdentifier }),
  ...goalValidators,
  'memory/list': goalShape({ root: atMost(4096, isFilled), at: goalHex([40, 64]) }),
  'memory/read': goalShape({ root: atMost(4096, isFilled), citation: goalCitation }),
  ...findingValidators,
  ...triggerValidators,
  ...authoringValidators,
  ...insightValidators,
  'host/hello': shape({ clientVersion: isString }),

  'runtime/health': shape({ runtime: isString }),
  'diagnostics/bundle': isObject,
  'runtime/models': shape({ runtime: isString }),
  'runtime/account': shape({ runtime: isString }),
  'runtime/limits': shape({ runtime: isString }),
  'usage/reports': isObject,
  'usage/refresh': shape({ runtime: optional(isString) }),
  'usage/ledger': shape({
    days: isNumber,
    runtime: optional(isString),
    groupBy: literalUnion('runtime', 'model', 'project'),
  }),
  'usage/scan': shape({ full: optional(isBoolean) }),
  'runtime/options': shape({ runtime: isString }),
  'runtime/refreshCatalog': shape({ runtime: isString }),
  'runtime/sessionDefaults': shape({
    runtime: isString,
    cwd: optional(isString),
    values: optional(recordOf(optionValueValidator)),
  }),
  'runtime/options/set': shape({ runtime: isString, optionId: isString, value: optionValueValidator }),
  'runtime/skills': shape({ runtime: isString, cwd: optional(isString) }),
  'runtime/skills/setEnabled': shape({ runtime: isString, name: isString, path: optional(isString), enabled: isBoolean }),
  'runtime/hooks': shape({ runtime: isString, cwd: optional(isString) }),
  'library/read': shape({ cwd: optional(isString) }),
  'library/definition': shape({
    kind: isString,
    name: isString,
    path: isString,
    cwd: optional(isString),
  }),
  'library/usage': shape({}),
  'library/plan': shape({ cwd: optional(isString), intents: arrayOf(libraryIntentValidator) }),
  'library/apply': shape({ cwd: optional(isString), ops: arrayOf(libraryPlannedOpValidator) }),
  // `null` is how a goal is cleared. `optional` turns it into undefined, and
  // the adapter clears only on null, so a clear arrived as nothing (#25).
  'session/goal': shape({ runtime: isString, sessionId: isString, objective: nullableString }),
  'audit/query': shape({ root: optional(isString), sinceDays: optional(isNumber) }),
  'credentials/list': isObject,
  'credentials/store': shape({ name: isString, value: isString }),
  'credentials/delete': shape({ ref: isString }),
  'runtime/apiKey/store': shape({ runtime: isString, methodId: isString, value: isString }),
  'runtime/apiKey/clear': shape({ runtime: isString, methodId: isString }),
  'routes/list': shape({ runtime: optional(isString) }),
  'routes/save': shape({
    id: optional(isString),
    name: isString,
    endpoint: isString,
    wireProtocol: isString,
    credentialRef: isString,
    model: optional(isString),
  }),
  'routes/delete': shape({ id: isString }),
  'runtime/login': shape({ runtime: isString, method: isString }),
  'runtime/login/cancel': shape({ runtime: isString, loginId: isString }),
  'runtime/logout': shape({ runtime: isString }),
  'runtime/account/add': shape({
    runtime: isString,
    gateway: optional(shape({ name: isString, endpoint: isString, apiKey: isString })),
  }),
  'runtime/account/remove': shape({ runtime: isString }),

  'session/list': shape({
    runtime: isString,
    cursor: optional(isString),
    pageSize: optional(isNumber),
    cwd: optional(isString),
    archived: optional(literalUnion('exclude', 'only')),
  }),
  'session/search': shape({ runtime: isString, query: isString }),
  'transcripts/search': shape({ query: isString }),
  'backup/export': isObject,
  'backup/import': shape({ backup: isObject }),
  'session/read': shape({ runtime: isString, sessionId: isString }),
  'session/create': shape({ runtime: isString, options: withoutHostOnly(shape({ cwd: isString })) }),
  'session/resume': shape({ runtime: isString, sessionId: isString, options: optional(withoutHostOnly(isObject)) }),
  'session/fork': shape({ runtime: isString, sessionId: isString, options: optional(withoutHostOnly(isObject)) }),
  'session/archive': shape({ runtime: isString, sessionId: isString, archived: isBoolean }),
  'session/delete': shape({ runtime: isString, sessionId: isString }),
  'session/close': shape({ runtime: isString, sessionId: isString }),
  'session/setTitle': shape({ runtime: isString, sessionId: isString, title: isString }),
  'session/settings': shape({ runtime: isString, sessionId: isString, patch: isObject }),
  'session/options/set': shape({
    runtime: isString,
    sessionId: isString,
    optionId: isString,
    value: optionValueValidator,
  }),
  'session/rollback': shape({ runtime: isString, sessionId: isString, turns: isNumber }),
  'session/revertTurn': shape({
    runtime: isString,
    sessionId: isString,
    turnId: isString,
    direction: optional(literalUnion('undo', 'redo')),
    skipUnrecoverable: optional(isBoolean),
  }),
  'session/compact': shape({ runtime: isString, sessionId: isString }),
  'session/memory': shape({ runtime: isString, sessionId: isString, enabled: isBoolean }),
  'session/review': shape({
    runtime: isString,
    sessionId: isString,
    target: reviewRequestValidator,
  }),

  'turn/send': shape({ runtime: isString, sessionId: isString, input: arrayOf(userContentValidator) }),
  'turn/steer': shape({ runtime: isString, sessionId: isString, input: arrayOf(userContentValidator) }),
  'turn/interrupt': shape({ runtime: isString, sessionId: isString }),
  'turn/queue': shape({ runtime: isString, sessionId: isString, input: arrayOf(userContentValidator) }),
  'turn/queue/cancel': shape({ runtime: isString, sessionId: isString, id: isString }),
  'turn/queue/move': shape({ runtime: isString, sessionId: isString, id: isString, to: isNumber }),
  'turn/queue/flush': shape({ runtime: isString, sessionId: isString }),
  'turn/queue/clear': shape({ runtime: isString, sessionId: isString }),

  'tasks/list': shape({ runtime: isString, sessionId: isString }),
  'tasks/stop': shape({ runtime: isString, sessionId: isString, taskId: isString }),
  'tasks/clear': shape({ runtime: isString, sessionId: isString }),

  'approval/respond': shape({
    runtime: isString,
    sessionId: isString,
    approvalId: isString,
    decision: approvalDecisionValidator,
  }),

  'acp/catalog': isObject,
  'acp/registry': isObject,
  'acp/register': shape({
    template: optional(isString),
    registry: optional(shape({ id: isString })),
    custom: optional(
      shape({
        name: isString,
        command: isString,
        args: optional(arrayOf(isString)),
        env: optional(recordOf(isString)),
        id: optional(isString),
      }),
    ),
  }),
  'acp/remove': shape({ runtime: isString }),
  'runtime/installs': shape({ runtime: isString }),
  'runtime/installs/use': shape({ runtime: isString, path: nullableString }),
  'acp/update': shape({ runtime: isString }),

  'workspace/recent': isObject,
  'workspace/open': shape({ path: isString }),
  'workspace/forget': shape({ path: isString }),
  'workspace/reveal': shape({ path: isString }),
  'workspace/pick': isObject,
  'workspace/files': shape({
    root: isString,
    query: isString,
    limit: optional(isNumber),
    runtime: optional(isString),
  }),
  'workspace/browse': shape({ path: optional(isString), runtime: optional(isString) }),
  'workspace/readFile': shape({
    path: isString,
    maxBytes: optional(isNumber),
    runtime: optional(isString),
    encoding: optional(literalUnion('utf8', 'base64')),
  }),
  'preview/ticket': shape({ path: isString, runtime: optional(isString) }),
  'workspace/stat': shape({ path: isString, runtime: optional(isString) }),
  'file/save': shape({
    path: isString,
    content: isString,
    expectedHash: isString,
    runtime: optional(isString),
  }),
  // A report is a tagged union, and the tag is what decides whether `hash` is
  // there — so it is checked by kind rather than as one shape with everything
  // optional, which would accept a `saved` with no hash.
  'editor/report': shape({
    event: taggedUnion<EditorEvent, 'kind'>('kind', {
      opened: shape({ kind: literalUnion('opened'), path: isString, at: isNumber }) as Validator<EditorEvent>,
      closed: shape({ kind: literalUnion('closed'), path: isString, at: isNumber }) as Validator<EditorEvent>,
      changed: shape({ kind: literalUnion('changed'), path: isString, at: isNumber }) as Validator<EditorEvent>,
      saved: shape({
        kind: literalUnion('saved'),
        path: isString,
        at: isNumber,
        hash: isString,
      }) as Validator<EditorEvent>,
    }),
  }),

  'terminal/open': shape({
    runtime: isString,
    cwd: isString,
    size: shape({ rows: isNumber, cols: isNumber }),
    sessionId: optional(isString),
    command: optional(arrayOf(isString)),
  }),
  'terminal/attach': shape({ terminalId: isString }),
  'terminal/write': shape({ terminalId: isString, data: isString }),
  'terminal/resize': shape({ terminalId: isString, size: shape({ rows: isNumber, cols: isNumber }) }),
  'terminal/close': shape({ terminalId: isString }),

  'worktree/list': shape({ root: isString }),
  'worktree/create': shape({ root: isString, name: isString, base: optional(isString) }),
  'worktree/changes': shape({ path: isString }),
  'worktree/remove': shape({ path: isString, force: optional(isBoolean) }),
  'worktree/bringHome': shape({ path: isString }),

  'team/state': shape({ room: isString }),
  'team/add': shape({
    room: isString,
    title: isString,
    detail: optional(isString),
    files: optional(arrayOf(isString)),
    dependsOn: optional(arrayOf(isNumber)),
    plan: optional(isNumber),
  }),
  'team/intent': shape({
    room: isString,
    id: isNumber,
    action: literalUnion('reopen', 'abandon', 'done', 'release', 'block'),
    /* What the person answered, on a card a flow addressed to them. `who:
       person` is a step and not an absence, and this is the word the next rule
       branches on — so the same warning as `reason` applies twice over: a verb
       on the wire type and not in this list is refused by the host, and
       nothing but a running app catches it. */
    outcome: optional(isString),
    context: optional(isString),
    /* Read on `block` and ignored by the rest. Adding the verb to the wire
       type and not to this list makes the host refuse it — and the refusal
       arrives as a rejected promise the surface reports as "the board is as it
       was", which is true and useless. Nothing but a running app can catch
       that: every test above the transport mocks the store. */
    reason: optional(isString),
  }),
  'team/post': shape({
    room: isString,
    text: isString,
    to: optional(shape({ runtime: isString, sessionId: isString })),
  }),
  'team/handout': shape({
    room: isString,
    template: isString,
    recipients: arrayOf(
      shape({ runtime: isString, sessionId: isString, vars: optional(recordOf(isString)) }),
    ),
  }),
  'team/messaging': shape({ room: isString, enabled: isBoolean }),
  'team/deliver': shape({ room: isString, entryId: isString }),
  'team/inbound': shape({
    runtime: isString,
    sessionId: isString,
    mode: literalUnion('accept', 'hold', 'refuse'),
  }),
  'team/peers': shape({ room: isString }),

  'team/rooms': shape({ root: isString }),

  'flow/list': shape({ root: isString }),
  'flow/read': shape({ root: isString, path: isString }),
  'flow/dry': shape({
    root: isString,
    source: isString,
    answers: optional(recordOf(arrayOf(isString))),
  }),
  'flow/start': shape({
    room: isString,
    source: isString,
    path: optional(isString),
    vars: optional(recordOf(isString)),
  }),
  'flow/stop': shape({ run: isString }),
  'flow/runs': shape({ room: isString }),

  'flow/catalog': goalShape({ root: isString }),
  'flow/source': goalShape({ root: isString, id: isFilled, origin: optional(literalUnion('project', 'user', 'builtin')) }),
  'flow/preview': goalShape({
    root: isString,
    source: atMost(256 * 1024),
    vars: optional(recordOf(isString)),
    retry: optional(shape({ run: isFilled, card: goalInteger(1) })),
  }),
  'flow/start-goal': goalShape({
    root: isString,
    source: atMost(256 * 1024),
    token: isFilled,
    sentence: isString,
    vars: optional(recordOf(isString)),
    goal: optional(startGoal),
  }),
  'flow/execution': goalShape({ run: isFilled }),
  'flow/execution/source': goalShape({ run: isFilled }),
  'flow/check/retry': goalShape({ run: isFilled, card: goalInteger(1), token: isFilled }),
  'flow/update/preview': goalShape({ root: isString, id: isFilled }),
  'flow/update/apply': goalShape({ root: isString, token: isFilled }),
  'flow/customize/preview': goalShape({ root: isString, id: isFilled }),
  'flow/customize/apply': goalShape({ root: isString, id: isFilled, token: isFilled }),

  'agent/list': shape({ project: optional(isString) }),
  'agent/read': shape({ id: isString, project: optional(isString) }),
  'agent/seat/dry': shape({ ids: optional(arrayOf(isString)), project: optional(isString) }),
  'agent/seat': shape({
    id: isFilled,
    cwd: isFilled,
    project: optional(isString),
    seats: optional(seatListValidator),
    permission: optional(grantValidator),
  }),
  'agent/seating/read': isObject,
  'agent/seating/set': shape({
    id: isFilled,
    seats: (value: unknown, path = '') => (value === null ? null : seatListValidator(value, path)),
    expected: optional((value: unknown, path = '') => (value === null ? null : seatListValidator(value, path))),
  }),
  'agent/create': shape({
    name: atMost(AGENT_NAME_LIMIT, isFilled),
    description: optional(atMost(AGENT_DESCRIPTION_LIMIT)),
    ceiling: ceilingValidator,
    seat: flowSeatValidator,
    to: literalUnion('user', 'project'),
    project: optional(isString),
  }),
  'agent/ceiling/preview': shape({
    id: isFilled,
    origin: literalUnion('user', 'project'),
    project: optional(isString),
    level: ceilingValidator,
  }),
  'agent/ceiling/write': shape({
    id: isFilled,
    origin: literalUnion('user', 'project'),
    project: optional(isString),
    level: ceilingValidator,
    digest: isFilled,
  }),
  'agent/copy': shape({
    id: isFilled,
    from: literalUnion('project', 'user', 'builtin'),
    to: literalUnion('user', 'project'),
    project: optional(isString),
  }),
  'agent/remove': shape({ id: isFilled, origin: literalUnion('user', 'project'), project: optional(isString) }),
  'agent/reveal': shape({
    id: isFilled,
    origin: optional(literalUnion('project', 'user', 'builtin')),
    project: optional(isString),
  }),

  // `goalShape`, not the plain `shape` most methods above use: decision 2 of
  // Task 5 is explicit that these particular methods reject an extra key
  // before dispatch — a ceiling, a digest, an "approved" or "loaded" flag, a
  // client can never plant on a request it does not own. `goalShape` is
  // exactly that check (already proven by every `goal/*` method above);
  // named for where it was first needed, not for what it is.
  'attachment/agent': goalShape({
    id: isFilled,
    origin: literalUnion('project', 'user', 'builtin'),
    project: optional(isString),
  }),
  'attachment/edit/preview': goalShape({
    id: isFilled,
    origin: literalUnion('user', 'project'),
    project: optional(isString),
    skills: arrayOf(isString),
    mcp: arrayOf(isString),
  }),
  'attachment/edit/write': goalShape({
    id: isFilled,
    origin: literalUnion('user', 'project'),
    project: optional(isString),
    skills: arrayOf(isString),
    mcp: arrayOf(isString),
    digest: isFilled,
  }),
  'attachment/notes': goalShape({
    id: isFilled,
    origin: literalUnion('project', 'user', 'builtin'),
    project: optional(isString),
  }),
  'attachment/notes/clear': goalShape({
    id: isFilled,
    origin: literalUnion('user', 'project'),
    project: optional(isString),
    digest: isFilled,
  }),
  'attachment/review': goalShape({
    id: isFilled,
    origin: literalUnion('project', 'user', 'builtin'),
    root: atMost(4096, isFilled),
    runtime: optional(isFilled),
  }),
  'attachment/approve': goalShape({ token: atMost(200, isFilled), acknowledgeHidden: optional(isBoolean) }),
  'attachment/seat': goalShape({ seat: isFilled }),

  'evidence/seat': shape({ runtime: isFilled, sessionId: isFilled }),
  'evidence/checks': shape({ project: isFilled }),
  'evidence/board': shape({ room: isFilled }),
  'evidence/check/run': shape({
    room: isFilled,
    card: isNumber,
    name: isFilled,
    seen: optional(isString),
    digest: optional(isString),
  }),

  'git/status': shape({ root: isString }),
  'git/branches': shape({ root: isString }),
  'git/checkout': shape({ root: isString, branch: isString, create: optional(isBoolean) }),
  'git/diff': shape({ root: isString, path: optional(isString), staged: optional(isBoolean) }),
  'git/log': shape({
    root: isString,
    scope: optional(literalUnion('all', 'head')),
    skip: optional(isNumber),
    limit: optional(isNumber),
    query: optional(isString),
    search: optional(literalUnion('message', 'author', 'sha', 'file')),
  }),
  'git/refs': shape({ root: isString }),
  'git/commit': shape({ root: isString, sha: isString }),
  'git/commitDiff': shape({ root: isString, sha: isString, path: isString }),
  'git/createBranch': shape({ root: isString, name: isString, at: isString, checkout: optional(isBoolean) }),
  'git/commitAll': shape({ root: isString, message: isString, paths: optional(arrayOf(isString)) }),
  'git/pull': shape({ root: isString }),
  'git/push': shape({ root: isString }),
  'git/fetch': shape({ root: isString }),
  'git/merge': shape({ root: isString, ref: isString }),
  'git/rebase': shape({ root: isString, onto: isString }),
  'git/checkoutCommit': shape({ root: isString, sha: isString }),
  'git/renameBranch': shape({ root: isString, from: isString, to: isString }),
  'git/deleteBranch': shape({ root: isString, name: isString, force: optional(isBoolean) }),
  'git/createTag': shape({ root: isString, name: isString, at: isString, message: optional(isString) }),
  'git/deleteTag': shape({ root: isString, name: isString }),
  'git/reset': shape({ root: isString, to: isString, mode: literalUnion('soft', 'mixed', 'hard') }),
  'git/revert': shape({ root: isString, sha: isString }),
  'git/cherryPick': shape({ root: isString, sha: isString }),
  'git/stashSave': shape({ root: isString, message: optional(isString) }),
  'git/stashApply': shape({ root: isString, ref: isString, pop: optional(isBoolean) }),
  'git/stashDrop': shape({ root: isString, ref: isString }),
  'git/patch': shape({ root: isString, sha: isString }),
  'git/diffRange': shape({ root: isString, from: isString, to: isString }),
  'git/pullRequestUrl': shape({ root: isString, branch: isString }),
  'git/worktrees': shape({ root: isString }),
  'git/worktreeAdd': shape({
    root: isString,
    path: isString,
    checkout: taggedUnion<GitWorktreeCheckout, 'kind'>('kind', {
      new: shape({
        kind: literalUnion('new'),
        branch: isString,
        base: optional(isString),
      }) as Validator<GitWorktreeCheckout>,
      existing: shape({ kind: literalUnion('existing'), branch: isString }) as Validator<GitWorktreeCheckout>,
      detach: shape({ kind: literalUnion('detach'), at: isString }) as Validator<GitWorktreeCheckout>,
    }),
  }),
  'git/worktreeInventory': shape({ root: isString, path: isString }),
  'git/worktreeRemove': shape({
    root: isString,
    path: isString,
    force: optional(isBoolean),
    expect: optional(isString),
  }),
  'git/worktreePrune': shape({ root: isString }),
  'git/worktreeLock': shape({
    root: isString,
    path: isString,
    locked: isBoolean,
    reason: optional(isString),
  }),
  'git/worktreeMove': shape({ root: isString, from: isString, to: isString }),

  'plugin/list': isObject,
  'plugin/setEnabled': shape({ pluginId: isString, enabled: isBoolean }),
  'plugin/configure': shape({ pluginId: isString, config: isObject }),
  'plugin/inspect': shape({ specifier: isString }),
  'plugin/install': shape({ specifier: isString }),
  'plugin/uninstall': shape({ pluginId: isString }),
  'capability/list': shape({
    kind: literalUnion('tool', 'hook', 'context', 'command', 'ui', 'agent', 'resource'),
    workspaceRoot: optional(isString),
    runtime: optional(isString),
    sessionId: optional(isString),
    turnId: optional(isString),
  }),
  'command/run': shape({
    name: isString,
    argument: isString,
    runtime: optional(isString),
    sessionId: optional(isString),
  }),
  'context/resolve': shape({
    id: isString,
    ref: optional(isString),
    runtime: optional(isString),
    sessionId: optional(isString),
    workspaceRoot: optional(isString),
  }),

  'runtime/catalog': shape({ runtime: isString, cwd: optional(isString) }),
  'runtime/apps/search': shape({ runtime: isString, query: isString, cursor: optional(isString) }),
  'runtime/plugin/install': shape({ runtime: isString, marketplace: isString, pluginName: isString }),
  'runtime/plugin/uninstall': shape({ runtime: isString, pluginId: isString }),
  'runtime/mcp/list': shape({ runtime: isString, cwd: optional(isString) }),
  'runtime/mcp/login': shape({ runtime: isString, name: isString }),
  'runtime/mcp/reload': shape({ runtime: isString }),
  'runtime/imports/detect': shape({ runtime: isString, cwd: optional(isString) }),
  'runtime/imports/apply': shape({ runtime: isString, items: arrayOf(isUnknown) }),

  'app/state/get': isObject,
  'app/state/set': shape({ patch: windowPreferences }),
  'app/browsers': isObject,
}

export const knownMethods = Object.keys(paramsValidators) as HostMethodName[]

export const isKnownMethod = (method: string): method is HostMethodName =>
  Object.prototype.hasOwnProperty.call(paramsValidators, method)

/** Parses and validates one inbound frame, or throws `ValidationError`. */
export const parseClientMessage = (raw: unknown): ClientToHost => {
  const source = isObject(raw, 'message')
  const id = isNumber(source['id'], 'message.id')
  const method = isString(source['method'], 'message.method')
  if (!isKnownMethod(method)) {
    throw new ValidationError('message.method', `unknown method ${JSON.stringify(method)}`)
  }
  const params = paramsValidators[method](source['params'], 'message.params')
  return { id, method, params } as WireRequest
}

export const wireError = (code: string, message: string, details?: string | null, data?: unknown): WireError => ({
  code,
  message,
  details: details ?? null,
  ...(data !== undefined && data !== null ? { data } : {}),
})

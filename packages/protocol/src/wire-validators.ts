import type { ApprovalDecision } from './approval.js'
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

/**
 * Per-method params validators. A method missing from this table is rejected,
 * so the table doubles as the host's method allowlist.
 */
const paramsValidators: Record<HostMethodName, Validator<unknown>> = {
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
  'session/goal': shape({ runtime: isString, sessionId: isString, objective: optional(isString) }),
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
  'session/create': shape({ runtime: isString, options: shape({ cwd: isString }) }),
  'session/resume': shape({ runtime: isString, sessionId: isString, options: optional(isObject) }),
  'session/fork': shape({ runtime: isString, sessionId: isString, options: optional(isObject) }),
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

  'agents/catalog': isObject,
  'agents/registry': isObject,
  'agents/register': shape({
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
  'agents/remove': shape({ runtime: isString }),
  'agents/installs': shape({ runtime: isString }),
  'agents/installs/use': shape({ runtime: isString, path: nullableString }),
  'agents/update': shape({ runtime: isString }),

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

  'team/state': shape({ room: isString }),
  'team/add': shape({
    room: isString,
    title: isString,
    detail: optional(isString),
    files: optional(arrayOf(isString)),
    dependsOn: optional(arrayOf(isNumber)),
    plan: optional(isNumber),
  }),
  'team/plan': shape({ room: isString, goal: isString }),
  'team/wrap': shape({ room: isString, plan: isNumber }),
  'team/intent': shape({
    room: isString,
    id: isNumber,
    action: literalUnion('reopen', 'abandon', 'done', 'release', 'block'),
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
  'team/room/create': shape({ root: isString, name: isString }),
  'team/room/rename': shape({ room: isString, name: isString }),
  'team/room/delete': shape({ room: isString }),
  'team/room/join': shape({ room: isString, runtime: isString, sessionId: isString }),
  'team/room/leave': shape({ room: isString, runtime: isString, sessionId: isString }),

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
  'context/resolve': shape({ id: isString, ref: optional(isString), runtime: optional(isString), workspaceRoot: optional(isString) }),

  'runtime/catalog': shape({ runtime: isString, cwd: optional(isString) }),
  'runtime/apps/search': shape({ runtime: isString, query: isString, cursor: optional(isString) }),
  'runtime/plugin/install': shape({ runtime: isString, marketplace: isString, pluginName: isString }),
  'runtime/plugin/uninstall': shape({ runtime: isString, pluginId: isString }),
  'runtime/plugin/setEnabled': shape({ runtime: isString, pluginId: isString, enabled: isBoolean }),
  'runtime/mcp/list': shape({ runtime: isString, cwd: optional(isString) }),
  'runtime/mcp/login': shape({ runtime: isString, name: isString }),
  'runtime/mcp/reload': shape({ runtime: isString }),
  'runtime/imports/detect': shape({ runtime: isString, cwd: optional(isString) }),
  'runtime/imports/apply': shape({ runtime: isString, items: arrayOf(isUnknown) }),

  'app/state/get': isObject,
  'app/state/set': shape({ patch: isObject }),
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

export const wireError = (code: string, message: string, details?: string | null): WireError => ({
  code,
  message,
  details: details ?? null,
})

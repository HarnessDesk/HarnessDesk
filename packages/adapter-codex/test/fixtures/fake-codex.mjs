#!/usr/bin/env node
/**
 * A scripted `codex` stand-in that plays a realistic turn.
 *
 * Exists so the adapter's end-to-end path — spawn, handshake, thread start, turn
 * streaming, approval round-trip, interrupt — is exercised against a real
 * process over real pipes, without credentials, network, or credits.
 */

import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// A real file on disk, so the adapter's icon inlining is exercised rather than
// mocked. Codex resolves an installed package's icon to an absolute path.
const ICON = fileURLToPath(new URL('./plugin-icon.svg', import.meta.url))

const version = process.env['FAKE_CODEX_VERSION'] ?? '0.149.0'
const mode = process.env['FAKE_CODEX_MODE'] ?? 'turn'

if (process.argv.includes('--version')) {
  /* A test can hold this answer open, to put a shutdown inside the window
     between "which Codex is installed?" and the app-server that answer starts
     — see `dispose.test.ts`. The wait is synchronous because the exit below
     has to stay synchronous: an async pause here would let the whole
     app-server beneath this branch run in a process that was only asked its
     version.

     It waits while the file *exists*, so the release is a delete. That way the
     temp directory every one of those tests already removes when it ends is
     itself the release, and a test that dies before releasing on purpose still
     frees this process on its way out — where waiting for a file to appear
     left a stand-in sitting here for the whole ceiling, long enough to look
     like the suite had hung. The ceiling is only for a test that dies without
     unwinding at all.

     The corollary, since it is a trap: setting FAKE_CODEX_HOLD without
     creating the file parks nothing, silently. Take the hold through
     `dispose.test.ts`'s `hold()`, which writes the file and sets the variable
     together, rather than setting the variable by hand. */
  const hold = process.env['FAKE_CODEX_HOLD']
  if (hold) {
    const idle = new Int32Array(new SharedArrayBuffer(4))
    const ceiling = Date.now() + 30_000
    while (existsSync(hold) && Date.now() < ceiling) Atomics.wait(idle, 0, 0, 20)
  }
  process.stdout.write(`codex-cli ${version}\n`)
  process.exit(0)
}

/* This generation's line in a test's ledger of app-servers, written before a
   word is read from stdin — so a test that has awaited a handshake has
   awaited this. Inert unless a test asks for it. */
if (process.env['FAKE_CODEX_CLAIMS']) {
  appendFileSync(process.env['FAKE_CODEX_CLAIMS'], `${process.pid}\n`)
}

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const notify = (method, params) => send({ method, params })

// Codex stamps turns in whole seconds and item lifecycles in milliseconds, and
// the fake keeps both units real: a turn stamped `1` reads in the app as a
// duration of fifty-six years, which is the fixture lying rather than the app
// failing. Anything driving this stand-in through the interface should see the
// clock it would see against the real thing.
const nowMs = () => Date.now()
const nowSeconds = () => Math.floor(Date.now() / 1000)

// FAKE_CODEX_CATALOG_WARNING=1 reproduces what 0.135.0 writes to stderr when
// it cannot decode its vendor's catalogue, ANSI colour and all; the model
// list it then serves is its compiled-in fallback.
if (process.env['FAKE_CODEX_CATALOG_WARNING'] === '1') {
  process.stderr.write(
    '\u001b[2m2026-08-22T23:08:07.095731Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_models_manager::manager\u001b[0m\u001b[2m:\u001b[0m ' +
      'failed to refresh available models: stream disconnected before completion: failed to decode models response: ' +
      'unknown variant `max`, expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh` at line 1 column 108801; body: {"models":[{"slug":"gpt-5.5"}]}\n',
  )
}

/**
 * The first thread is always `thread-e2e` so tests can address it by name;
 * each further `thread/start` gets its own id, so two panes can hold two
 * conversations. Notifications go to whichever thread the request named.
 */
let THREAD = 'thread-e2e'
let TURN = 'turn-e2e'
let threadCounter = 0
const nextThreadId = () => (threadCounter++ === 0 ? 'thread-e2e' : `thread-e2e-${threadCounter}`)

const thread = (overrides = {}) => ({
  id: THREAD,
  sessionId: THREAD,
  forkedFromId: null,
  preview: 'List the files here.',
  ephemeral: false,
  modelProvider: 'openai',
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_100,
  status: { type: 'idle' },
  path: '/tmp/rollout.jsonl',
  cwd: '/w',
  cliVersion: version,
  source: 'vscode',
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: { sha: 'abc123', branch: 'main', originUrl: 'git@example.com:me/repo.git' },
  name: null,
  turns: [],
  ...overrides,
})

/**
 * Thread settings, the way the real app-server keeps them (observed on
 * 0.135.0): `thread/settings/update` changes one or more fields and is
 * answered with `{}` plus a `thread/settings/updated` notification carrying
 * the whole record; `permissions` cannot be combined with a sandbox; an
 * unknown profile is refused; an unknown model is accepted without complaint.
 */
const SANDBOX_FOR_PROFILE = {
  ':read-only': { type: 'readOnly', networkAccess: false },
  ':workspace': { type: 'workspaceWrite', writableRoots: ['/w'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  ':danger-full-access': { type: 'dangerFullAccess' },
}
const PROFILES = [
  { id: ':read-only', description: null, allowed: true },
  { id: ':workspace', description: null, allowed: true },
  { id: ':danger-full-access', description: null, allowed: true },
  { id: 'ci', description: 'Defined in this project', allowed: true },
]
const settingsState = {
  cwd: '/w',
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  permissions: null,
  sandboxType: 'workspaceWrite',
  model: 'gpt-5.5',
  serviceTier: null,
  effort: null,
  mode: 'default',
}
const sandboxPolicy = () =>
  settingsState.permissions
    ? (SANDBOX_FOR_PROFILE[settingsState.permissions] ?? SANDBOX_FOR_PROFILE[':workspace'])
    : { ':read-only': SANDBOX_FOR_PROFILE[':read-only'], workspaceWrite: SANDBOX_FOR_PROFILE[':workspace'], readOnly: SANDBOX_FOR_PROFILE[':read-only'], dangerFullAccess: SANDBOX_FOR_PROFILE[':danger-full-access'] }[settingsState.sandboxType]

const threadSettings = () => ({
  cwd: settingsState.cwd,
  approvalPolicy: settingsState.approvalPolicy,
  approvalsReviewer: settingsState.approvalsReviewer,
  sandboxPolicy: sandboxPolicy(),
  activePermissionProfile: settingsState.permissions ? { id: settingsState.permissions, extends: null } : null,
  model: settingsState.model,
  modelProvider: 'openai',
  serviceTier: settingsState.serviceTier,
  effort: settingsState.effort,
  summary: null,
  collaborationMode: {
    mode: settingsState.mode,
    settings: { model: settingsState.model, reasoning_effort: settingsState.effort, developer_instructions: null },
  },
  personality: 'pragmatic',
})

/** Applies thread-verb params (start/resume/fork) or settings-update params. Returns an error message or null. */
const applySettings = (params, { sandboxKey }) => {
  if (params.permissions != null && params[sandboxKey] != null) {
    return `\`permissions\` cannot be combined with \`${sandboxKey}\``
  }
  if (params.permissions != null && !PROFILES.some((p) => p.id === params.permissions)) {
    return 'failed to load configuration: default_permissions requires a `[permissions]` table'
  }
  if (params.model != null) settingsState.model = params.model
  if (params.permissions != null) settingsState.permissions = params.permissions
  if (params[sandboxKey] != null) {
    settingsState.permissions = null
    const value = params[sandboxKey]
    settingsState.sandboxType =
      value === 'read-only' || value?.type === 'readOnly' ? 'readOnly'
      : value === 'danger-full-access' || value?.type === 'dangerFullAccess' ? 'dangerFullAccess'
      : 'workspaceWrite'
  }
  if (params.approvalPolicy != null) settingsState.approvalPolicy = params.approvalPolicy
  if (params.approvalsReviewer != null) settingsState.approvalsReviewer = params.approvalsReviewer
  if (params.serviceTier !== undefined) settingsState.serviceTier = params.serviceTier
  if (params.effort !== undefined) settingsState.effort = params.effort
  if (params.cwd != null) settingsState.cwd = params.cwd
  if (params.collaborationMode) {
    settingsState.mode = params.collaborationMode.mode
    settingsState.effort = params.collaborationMode.settings.reasoning_effort
  }
  return null
}

const startResponse = () => ({
  // A thread that has only just started has said nothing yet: the real
  // app-server returns an empty preview here and fills it in once a turn of
  // it has been stored.
  thread: thread({ preview: '' }),
  model: settingsState.model,
  modelProvider: 'openai',
  serviceTier: settingsState.serviceTier,
  cwd: settingsState.cwd,
  runtimeWorkspaceRoots: ['/w'],
  instructionSources: [],
  approvalPolicy: settingsState.approvalPolicy,
  approvalsReviewer: settingsState.approvalsReviewer,
  sandbox: sandboxPolicy(),
  activePermissionProfile: settingsState.permissions ? { id: settingsState.permissions, extends: null } : null,
  reasoningEffort: settingsState.effort,
})

const FEATURES = [
  { name: 'memories', stage: 'beta', displayName: 'Memories', description: 'Let the agent keep memories across conversations.', announcement: '', enabled: false, defaultEnabled: false },
  { name: 'prevent_idle_sleep', stage: 'beta', displayName: 'Prevent sleep while running', description: 'Keep the machine awake during a thread.', announcement: '', enabled: false, defaultEnabled: false },
  { name: 'internal_flag', stage: 'underDevelopment', displayName: null, description: null, announcement: null, enabled: true, defaultEnabled: true },
  { name: 'old_flag', stage: 'removed', displayName: null, description: null, announcement: null, enabled: false, defaultEnabled: false },
  { name: 'silent_flag', stage: 'beta', displayName: 'Silently refused', description: 'A flag 0.153.0 lists but will not flip while running.', announcement: '', enabled: false, defaultEnabled: false },
]
/** Mirrors the real server: only some features can be flipped at runtime. */
const RUNTIME_SETTABLE = new Set(['memories'])
/**
 * Mirrors 0.153.0, where a listed feature the server will not flip at runtime
 * is answered with an empty `enablement` map and no error at all — the
 * silence this adapter has to read as a refusal.
 */
const SILENTLY_REFUSED = new Set(['silent_flag'])

let approvalRequestId = 5000
const answeredApprovals = []
/** Which thread each approval request belongs to, so the answer finishes the right turn. */
const askedBy = new Map()

/**
 * Sign-in, the way the real app-server behaves (observed against 0.135.0 with
 * a throwaway CODEX_HOME): one login active at a time, a new start supersedes
 * the old one with a failed `account/login/completed`, cancel answers
 * `canceled` and then also emits a failed completion, an id never issued is a
 * JSON-RPC error, and logout emits `account/updated`.
 *
 * FAKE_CODEX_ACCOUNT=signedOut starts signed out. FAKE_CODEX_LOGIN decides what
 * a started login does on its own: `succeed`, `fail`, or (default) `hang` until
 * cancelled — the browser arm really does wait on another application.
 */
let signedIn = (process.env['FAKE_CODEX_ACCOUNT'] ?? 'signedIn') !== 'signedOut'
const loginOutcome = process.env['FAKE_CODEX_LOGIN'] ?? 'hang'
const forcedLoginMethod = process.env['FAKE_CODEX_FORCED_LOGIN'] ?? null
let activeLogin = null
const retiredLogins = new Set()
let loginCounter = 0

const completeLogin = (loginId, success, error) => {
  if (activeLogin?.id === loginId) activeLogin = null
  retiredLogins.add(loginId)
  if (success) signedIn = true
  notify('account/login/completed', { loginId, success, error })
  if (success) notify('account/updated', { authMode: 'chatgpt', planType: 'team' })
}

const startLogin = (type) => {
  if (activeLogin) completeLogin(activeLogin.id, false, 'Login server error: Login cancelled')
  const id = `login-${++loginCounter}`
  activeLogin = { id, type }
  const response =
    type === 'chatgptDeviceCode'
      ? { type, loginId: id, verificationUrl: 'https://auth.example.com/codex/device', userCode: `CODE-${loginCounter}` }
      : { type, loginId: id, authUrl: `https://auth.example.com/oauth/authorize?state=${id}` }
  if (loginOutcome === 'succeed') setTimeout(() => completeLogin(id, true, null), 30)
  if (loginOutcome === 'fail') {
    setTimeout(() => completeLogin(id, false, 'Login server error: token exchange failed'), 30)
  }
  return response
}
/** dynamicTools the client declared on thread/start, so the tool round trip is testable. */
let declaredTools = []

/**
 * 0.149.0 declares dynamic tools as a tagged union: a `namespace` spec carries
 * its tools, a `function` spec stands alone. The fake flattens both back to the
 * (namespace, tool) pairs the call round trip is keyed on.
 */
const flattenDynamicTools = (specs) =>
  specs.flatMap((spec) =>
    spec.type === 'namespace'
      ? spec.tools.map((tool) => ({ namespace: spec.name, name: tool.name }))
      : [{ namespace: null, name: spec.name }],
  )
const toolAnswers = []

/** The last turn/start's input, echoed back the way the real app-server echoes it. */
let lastInput = null

/**
 * Token counts, the way the real app-server reports them on every response:
 * `last` is the latest response (its input is the whole context, so it grows
 * by the previous response's size), `total` the sum so far, and the window
 * is the model's. Reasoning is part of the output and dropped from context.
 */
let turnsPlayed = 0
const runningTotal = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }
const nextUsage = () => {
  turnsPlayed += 1
  const last = {
    inputTokens: 9000 + 45000 * turnsPlayed,
    cachedInputTokens: 40000 * turnsPlayed,
    outputTokens: 1800,
    reasoningOutputTokens: 600,
    totalTokens: 0,
  }
  last.totalTokens = last.inputTokens + last.outputTokens
  for (const key of Object.keys(runningTotal)) runningTotal[key] += last[key]
  return { total: { ...runningTotal }, last, modelContextWindow: 272000 }
}

let turnStartedAt = nowSeconds()

const playTurn = () => {
  turnStartedAt = nowSeconds()
  notify('turn/started', {
    threadId: THREAD,
    turn: { id: TURN, items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: turnStartedAt },
  })
  notify('thread/status/changed', { threadId: THREAD, status: { type: 'active', activeFlags: [] } })

  const userItem = {
    type: 'userMessage',
    id: 'item-u1',
    content:
      Array.isArray(lastInput) && lastInput.length > 0
        ? lastInput.map((part) => (part.type === 'text' ? { ...part, text_elements: part.text_elements ?? [] } : part))
        : [{ type: 'text', text: 'List the files here.', text_elements: [] }],
  }
  notify('item/started', { threadId: THREAD, turnId: TURN, item: userItem, startedAtMs: nowMs() })
  notify('item/completed', { threadId: THREAD, turnId: TURN, item: userItem, completedAtMs: nowMs() })

  const message = { type: 'agentMessage', id: 'item-a1', text: '', phase: 'commentary', memoryCitation: null }
  notify('item/started', { threadId: THREAD, turnId: TURN, item: message, startedAtMs: nowMs() })
  notify('item/agentMessage/delta', { threadId: THREAD, turnId: TURN, itemId: 'item-a1', delta: 'Running ' })
  notify('item/agentMessage/delta', { threadId: THREAD, turnId: TURN, itemId: 'item-a1', delta: 'ls.' })
  notify('item/completed', {
    threadId: THREAD,
    turnId: TURN,
    item: { ...message, text: 'Running ls.' },
    completedAtMs: nowMs(),
  })

  const command = {
    type: 'commandExecution',
    id: 'call-c1',
    command: 'ls -la',
    cwd: '/w',
    processId: null,
    source: 'agent',
    status: 'inProgress',
    commandActions: [{ type: 'listFiles', command: 'ls -la', path: '/w' }],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  }
  notify('item/started', { threadId: THREAD, turnId: TURN, item: command, startedAtMs: nowMs() })

  // Ask before running, then finish once the client answers.
  const id = ++approvalRequestId
  askedBy.set(id, THREAD)
  send({
    id,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'call-c1',
      startedAtMs: nowMs(),
      reason: 'Needs to read the working directory',
      command: 'ls -la',
      cwd: '/w',
      commandActions: [{ type: 'listFiles', command: 'ls -la', path: '/w' }],
      availableDecisions: ['accept', 'acceptForSession', 'decline'],
    },
  })
}

/**
 * Background terminals, in the shape `thread/backgroundTerminals/list`
 * returns them — the live set only, with the process figures, and no memory
 * at all of what has finished. Driven by the prompt so a test can start one,
 * let it die, and see the adapter work out which happened:
 *
 * - `bg <command>` opens a shell session (a `unifiedExecStartup` item that
 *   completes, leaving the process alive);
 * - `endbg <processId>` kills it behind the adapter's back, the way a real
 *   process exiting does — Codex says nothing, it simply stops being listed;
 * - `failbg <command>` is a startup that never left a process behind.
 */
const backgroundTerminals = new Map()
let backgroundCounter = 0

const startBackground = (command, { fails = false } = {}) => {
  backgroundCounter += 1
  const processId = String(1000 + backgroundCounter)
  const itemId = `call-bg${backgroundCounter}`
  const base = {
    type: 'commandExecution',
    id: itemId,
    command,
    cwd: '/w',
    processId,
    source: 'unifiedExecStartup',
    commandActions: [{ type: 'unknown', command }],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  }
  notify('item/started', {
    threadId: THREAD,
    turnId: TURN,
    item: { ...base, status: 'inProgress' },
    startedAtMs: nowMs(),
  })
  if (!fails) {
    backgroundTerminals.set(processId, {
      itemId,
      processId,
      command,
      cwd: '/w',
      osPid: 40000 + backgroundCounter,
      cpuPercent: 1.5,
      rssKb: 20480,
    })
  }
  notify('item/completed', {
    threadId: THREAD,
    turnId: TURN,
    item: { ...base, status: fails ? 'failed' : 'completed', exitCode: fails ? 1 : 0, durationMs: 5 },
    completedAtMs: nowMs(),
  })
  return processId
}

const finishTurn = () => {
  notify('item/commandExecution/outputDelta', {
    threadId: THREAD,
    turnId: TURN,
    itemId: 'call-c1',
    delta: 'README.md\n',
  })
  notify('item/completed', {
    threadId: THREAD,
    turnId: TURN,
    item: {
      type: 'commandExecution',
      id: 'call-c1',
      command: 'ls -la',
      cwd: '/w',
      processId: null,
      source: 'agent',
      status: 'completed',
      commandActions: [{ type: 'listFiles', command: 'ls -la', path: '/w' }],
      aggregatedOutput: 'README.md\n',
      exitCode: 0,
      durationMs: 12,
    },
    completedAtMs: nowMs(),
  })
  notify('thread/tokenUsage/updated', { threadId: THREAD, turnId: TURN, tokenUsage: nextUsage() })
  notify('turn/completed', {
    threadId: THREAD,
    turn: {
      id: TURN,
      items: [],
      itemsView: 'summary',
      status: 'completed',
      error: null,
      startedAt: turnStartedAt,
      completedAt: nowSeconds(),
      durationMs: 5000,
    },
  })
  notify('thread/status/changed', { threadId: THREAD, status: { type: 'idle' } })
}

/** Invokes the first client-declared tool, the way Codex does when the model picks one. */
const callDeclaredTool = () => {
  const tool = declaredTools[0]
  if (!tool) {
    notify('warning', { threadId: THREAD, message: 'TOOLS_DECLARED (none)' })
    return
  }
  send({
    id: ++approvalRequestId,
    method: 'item/tool/call',
    params: {
      threadId: THREAD,
      turnId: TURN,
      callId: 'call-dyn-1',
      namespace: tool.namespace ?? null,
      tool: tool.name,
      arguments: { text: 'from codex' },
    },
  })
}

/**
 * A small filesystem for the `fs/*` and `fuzzyFileSearch` methods. The real
 * app-server serves the host filesystem unsandboxed; the fake serves this
 * tree the same way — whatever is asked for, if it exists.
 */
const FILES = {
  '/w/README.md': 'hello from w\n',
  '/w/src/user_service.ts': 'export const x = 1\n',
  '/w/src/index.ts': '',
  '/etc/hosts': '127.0.0.1 localhost\n',
}
const DIRECTORIES = ['/', '/w', '/w/src', '/etc']
const childrenOf = (dir) => {
  const prefix = dir === '/' ? '/' : `${dir}/`
  const names = new Map()
  for (const path of [...Object.keys(FILES), ...DIRECTORIES]) {
    if (path === dir || !path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    const name = rest.split('/')[0]
    if (!name) continue
    const isDirectory = rest.includes('/') || DIRECTORIES.includes(path)
    names.set(name, { fileName: name, isDirectory, isFile: !isDirectory })
  }
  return [...names.values()]
}
const watches = new Map()
/** Live `command/exec` children by client-supplied processId. */
const processes = new Map()
/**
 * `emit-after-exit`: a process whose exec *response* and whose last output
 * delta are each held back until a later `command/exec` releases them.
 *
 * The response is not the end of the output. The real server answers
 * `command/exec` when the child exits, which is not when the child's stdout
 * has drained — `'close'` is that event — and nothing in the protocol orders
 * the response against that process's own deltas. So a trailing chunk
 * legally arrives after it. The ordinary commands below do it by accident
 * whenever the last chunk lands after Node's `'exit'`; this one does it on
 * purpose.
 *
 * Two stages rather than one, each released by a separate round trip, so
 * nothing races the client's own bookkeeping: the caller gets to attach a
 * listener while the process is still running (which is what the host does),
 * and the trailing delta is sent only once the caller has seen the exit.
 * Written back to back they could reach the client in a single read, and the
 * delta would be handled before the response's own handler had run — the
 * ordering under test would never happen.
 */
let armedExit = null
let armedDelta = null
const releaseArmed = () => {
  if (armedExit) {
    const { id: armedId, processId } = armedExit
    armedExit = null
    armedDelta = {
      processId,
      stream: 'stdout',
      deltaBase64: Buffer.from('after-the-response\n').toString('base64'),
      capReached: false,
    }
    send({ id: armedId, result: { exitCode: 0, stdout: '', stderr: '' } })
    return
  }
  if (armedDelta) {
    const delta = armedDelta
    armedDelta = null
    notify('command/exec/outputDelta', delta)
  }
}
/** Which curated plugins are installed, so install/uninstall are observable. */
const pluginState = {}
/** Which skills are enabled, so the toggle is observable. */
const skillState = {}
let importsApplied = false
const fuzzy = (query, candidate) => {
  const indices = []
  let cursor = 0
  for (const ch of query.toLowerCase()) {
    const index = candidate.toLowerCase().indexOf(ch, cursor)
    if (index === -1) return null
    indices.push(index)
    cursor = index + 1
  }
  return indices
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }

  if (message.method === 'initialized') return

  // Client answering one of our server-initiated requests.
  if (message.id !== undefined && message.method === undefined) {
    // Tool-call answers carry contentItems rather than a decision.
    if (message.result && Array.isArray(message.result.contentItems)) {
      toolAnswers.push(message.result)
      const text = message.result.contentItems
        .map((item) => (item.type === 'inputText' ? item.text : '[image]'))
        .join(' ')
      notify('warning', {
        threadId: THREAD,
        message: `TOOL_ANSWER success=${message.result.success} body=${text}`,
      })
      return
    }
    answeredApprovals.push(message)
    const asked = askedBy.get(message.id)
    if (asked) {
      THREAD = asked
      TURN = `turn-${THREAD}`
    }
    const decision = message.result?.decision
    if (decision === 'decline') {
      notify('turn/completed', {
        threadId: THREAD,
        turn: { id: TURN, items: [], itemsView: 'summary', status: 'completed', error: null },
      })
    } else {
      finishTurn()
    }
    return
  }

  const { id, method, params } = message

  switch (method) {
    case 'initialize':
      send({
        id,
        result: {
          userAgent: `fake/${version}`,
          codexHome: '/tmp/fake-codex-home',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      })
      return

    case 'thread/start': {
      THREAD = nextThreadId()
      TURN = `turn-${THREAD}`
      declaredTools = flattenDynamicTools(params?.dynamicTools ?? [])
      // Codex reserves these namespaces for its own Responses tools and
      // refuses the whole thread/start on a collision. Still true on 0.149.0,
      // whose wording this is, verified against the real app-server.
      const reserved = declaredTools.find((tool) => ['web', 'computer', 'container', 'browser'].includes(tool.namespace))
      if (reserved) {
        send({
          id,
          error: {
            code: -32600,
            message: `dynamic tool namespace collides with a reserved Responses API namespace: ${reserved.namespace}`,
          },
        })
        return
      }
      const problem = applySettings(params ?? {}, { sandboxKey: 'sandbox' })
      if (problem) {
        send({ id, error: { code: -32600, message: problem } })
        return
      }
      send({ id, result: startResponse() })
      notify('thread/started', { thread: thread() })
      notify('warning', {
        threadId: THREAD,
        message: `TOOLS_DECLARED ${declaredTools.map((t) => (t.namespace ? `${t.namespace}/${t.name}` : t.name)).join(',') || '(none)'}`,
      })
      return
    }

    case 'thread/resume':
    case 'thread/fork': {
      THREAD = method === 'thread/resume' ? params.threadId : nextThreadId()
      TURN = `turn-${THREAD}`
      const problem = applySettings(params ?? {}, { sandboxKey: 'sandbox' })
      if (problem) {
        send({ id, error: { code: -32600, message: problem } })
        return
      }
      send({ id, result: startResponse() })
      notify('thread/started', { thread: thread() })
      return
    }

    case 'thread/memoryMode/set':
      notify('warning', { threadId: params.threadId, message: `MEMORY ${params.mode}` })
      send({ id, result: {} })
      return

    case 'thread/rollback':
      notify('warning', { threadId: params.threadId, message: `ROLLBACK ${params.numTurns}` })
      send({ id, result: { thread: thread() } })
      return

    case 'thread/compact/start':
      send({ id, result: {} })
      notify('thread/compacted', { threadId: params.threadId })
      return

    case 'review/start':
      send({ id, result: { turn: { id: 'review-turn', items: [], itemsView: 'full', status: 'inProgress', error: null }, reviewThreadId: 'review-1' } })
      notify('warning', { threadId: params.threadId, message: `REVIEW ${params.target.type} ${params.delivery ?? 'default'}` })
      return

    case 'thread/settings/update': {
      const problem = applySettings(params, { sandboxKey: 'sandboxPolicy' })
      if (problem) {
        send({ id, error: { code: -32600, message: problem } })
        return
      }
      send({ id, result: {} })
      notify('thread/settings/updated', { threadId: params.threadId, threadSettings: threadSettings() })
      return
    }

    case 'fuzzyFileSearch': {
      const files = []
      if (params.query.length > 0) {
        for (const root of params.roots) {
          const prefix = `${root.replace(/\/$/, '')}/`
          for (const path of Object.keys(FILES)) {
            if (!path.startsWith(prefix)) continue
            const relativePath = path.slice(prefix.length)
            const indices = fuzzy(params.query, relativePath)
            if (!indices) continue
            files.push({ root, path: relativePath, match_type: 'file', file_name: relativePath.split('/').pop(), score: 100 - relativePath.length, indices })
          }
        }
      }
      files.sort((a, b) => b.score - a.score)
      send({ id, result: { files } })
      return
    }

    case 'fs/readFile': {
      if (!params.path.startsWith('/')) {
        send({ id, error: { code: -32600, message: 'Invalid request: AbsolutePathBuf deserialized without a base path' } })
        return
      }
      const content = FILES[params.path]
      if (content === undefined) {
        send({ id, error: { code: -32600, message: 'No such file or directory (os error 2)' } })
        return
      }
      send({ id, result: { dataBase64: Buffer.from(content).toString('base64') } })
      return
    }

    case 'fs/writeFile':
      if (!params.path.startsWith('/')) {
        send({ id, error: { code: -32600, message: 'Invalid request: AbsolutePathBuf deserialized without a base path' } })
        return
      }
      FILES[params.path] = Buffer.from(params.dataBase64, 'base64').toString()
      send({ id, result: {} })
      return

    case 'command/exec': {
      // Every exec releases the next stage of an armed `emit-after-exit`.
      releaseArmed()
      if (params.command[0] === 'emit-after-exit') {
        // No child and no response yet: from the client's side this is a
        // process that started and is still running.
        armedExit = { id, processId: params.processId }
        return
      }
      // A real child process, so stdin, exit codes and termination are
      // genuine; the sandbox is imitated by refusing a command the profile
      // would block, the way the real server's Seatbelt does.
      if (params.permissionProfile === ':read-only' && params.command.includes('touch')) {
        send({ id, result: { exitCode: 1, stdout: '', stderr: 'touch: Operation not permitted\n' } })
        return
      }
      const child = spawn(params.command[0], params.command.slice(1), {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FAKE_TTY: params.tty ? '1' : '0' },
      })
      const pid = params.processId
      if (pid) processes.set(pid, child)
      const forward = (stream) => (chunk) => {
        if (params.streamStdoutStderr && pid) {
          notify('command/exec/outputDelta', { processId: pid, stream, deltaBase64: Buffer.from(chunk).toString('base64'), capReached: false })
        } else buffered[stream] += String(chunk)
      }
      const buffered = { stdout: '', stderr: '' }
      child.stdout.on('data', forward('stdout'))
      child.stderr.on('data', forward('stderr'))
      child.on('error', (error) => {
        if (pid) processes.delete(pid)
        send({ id, error: { code: -32600, message: `failed to spawn: ${error.message}` } })
      })
      child.on('exit', (code, signal) => {
        if (pid) processes.delete(pid)
        send({ id, result: { exitCode: code ?? (signal ? 128 : -1), stdout: buffered.stdout, stderr: buffered.stderr } })
      })
      return
    }

    case 'command/exec/write': {
      const child = processes.get(params.processId)
      if (!child) {
        send({ id, error: { code: -32600, message: `unknown processId ${params.processId}` } })
        return
      }
      if (params.deltaBase64) child.stdin.write(Buffer.from(params.deltaBase64, 'base64'))
      if (params.closeStdin) child.stdin.end()
      send({ id, result: {} })
      return
    }

    case 'command/exec/resize': {
      const child = processes.get(params.processId)
      if (!child) {
        send({ id, error: { code: -32600, message: `unknown processId ${params.processId}` } })
        return
      }
      // No PTY under the fake; announce the size on stdout so a test can see it landed.
      notify('command/exec/outputDelta', { processId: params.processId, stream: 'stdout', deltaBase64: Buffer.from(`[resized ${params.size.rows}x${params.size.cols}]`).toString('base64'), capReached: false })
      send({ id, result: {} })
      return
    }

    case 'command/exec/terminate': {
      const child = processes.get(params.processId)
      if (child) child.kill('SIGTERM')
      send({ id, result: {} })
      return
    }

    case 'fs/readDirectory':
      if (!DIRECTORIES.includes(params.path)) {
        send({ id, error: { code: -32600, message: 'No such file or directory (os error 2)' } })
        return
      }
      send({ id, result: { entries: childrenOf(params.path) } })
      return

    case 'fs/getMetadata': {
      const isFile = params.path in FILES
      const isDirectory = DIRECTORIES.includes(params.path)
      if (!isFile && !isDirectory) {
        send({ id, error: { code: -32600, message: 'No such file or directory (os error 2)' } })
        return
      }
      send({ id, result: { isDirectory, isFile, isSymlink: false, createdAtMs: 1_700_000_000_000, modifiedAtMs: 1_700_000_001_000 } })
      return
    }

    case 'fs/watch': {
      // The real watch reports a top-level change a few hundred milliseconds
      // later; the fake reports one synthetic change soon after registering
      // and another later, so an unwatch in between is observable.
      watches.set(params.watchId, params.path)
      send({ id, result: { path: params.path } })
      const report = (suffix) => {
        if (!watches.has(params.watchId)) return
        notify('fs/changed', { watchId: params.watchId, changedPaths: [`${params.path}/${suffix}`] })
      }
      setTimeout(() => report('first.txt'), 30)
      setTimeout(() => report('second.txt'), 160)
      return
    }

    case 'fs/unwatch':
      watches.delete(params.watchId)
      send({ id, result: {} })
      return

    case 'skills/list':
      send({
        id,
        result: {
          data: [
            { cwd: params.cwds?.[0] ?? '/w', skills: [
              { name: 'review-checklist', description: 'A review checklist', shortDescription: null, interface: { displayName: null, shortDescription: null, brandColor: null, iconSmall: null, iconSmallUrl: 'https://example.test/remote-only.png', iconLargeUrl: null }, path: '/w/.agents/skills/review-checklist', scope: 'repo', enabled: skillState['review-checklist'] ?? true },
              { name: 'release-notes', description: 'Draft release notes', shortDescription: null, interface: null, path: '/w/.agents/skills/release-notes', scope: 'user', enabled: skillState['release-notes'] ?? false },
              { name: 'add-admin-task', description: 'The long trigger paragraph the model reads.', shortDescription: 'Add a testable task', interface: { displayName: 'Add Admin Task', shortDescription: 'Add a testable task', brandColor: '#0f766e', iconSmall: ICON, iconSmallUrl: 'https://example.test/icon.png', iconLargeUrl: null }, path: '/w/.agents/skills/add-admin-task', scope: 'user', enabled: true },
            ] },
          ],
        },
      })
      return

    case 'skills/config/write':
      skillState[params.name ?? (params.path ?? '').split('/').pop()] = params.enabled
      send({ id, result: {} })
      notify('skills/changed', {})
      return

    case 'hooks/list':
      send({
        id,
        result: {
          data: [
            { cwd: params.cwds?.[0] ?? '/w', hooks: [
              { key: 'guard-1', eventName: 'preToolUse', handlerType: 'command', matcher: null, command: 'guard', timeoutSec: 5, statusMessage: null, sourcePath: '/w/.codex/hooks', source: 'project', pluginId: null, displayOrder: 0, enabled: true, isManaged: false, currentHash: 'h', trustStatus: 'trusted' },
              { key: 'managed-1', eventName: 'postToolUse', handlerType: 'command', matcher: null, command: 'audit', timeoutSec: 5, statusMessage: null, sourcePath: '/mdm', source: 'mdm', pluginId: null, displayOrder: 1, enabled: true, isManaged: true, currentHash: 'h', trustStatus: 'managed' },
            ], warnings: [], errors: [] },
          ],
        },
      })
      return

    case 'externalAgentConfig/detect':
      send({
        id,
        result: {
          items: importsApplied ? [] : [
            { itemType: 'MCP_SERVER_CONFIG', description: 'Migrate MCP servers from ~', cwd: null, details: null },
            { itemType: 'SKILLS', description: 'Migrate skills from ~/.claude/skills', cwd: null, details: null },
            // Codex offers another agent's transcripts too; the adapter drops
            // this one before anyone can accept it.
            { itemType: 'SESSIONS', description: 'Migrate 58 sessions from Claude Code', cwd: null, details: null },
          ],
        },
      })
      return

    case 'externalAgentConfig/import':
      importsApplied = true
      send({ id, result: {} })
      notify('externalAgentConfig/import/completed', {})
      return

    case 'plugin/list':
      send({
        id,
        result: {
          marketplaces: [
            {
              name: 'openai-curated',
              path: null,
              interface: { displayName: 'Curated' },
              plugins: [
                {
                  id: 'documents@openai-curated',
                  remotePluginId: null,
                  localVersion: '1.0.0',
                  name: 'documents',
                  shareContext: null,
                  source: { type: 'remote' },
                  installed: pluginState.documents ?? true,
                  enabled: pluginState.documents ?? true,
                  installPolicy: 'AVAILABLE',
                  authPolicy: 'ON_USE',
                  availability: 'AVAILABLE',
                  interface: {
                    displayName: 'Documents',
                    shortDescription: 'Create and edit documents',
                    longDescription: null,
                    developerName: 'OpenAI',
                    category: 'Productivity',
                    capabilities: ['Write'],
                    websiteUrl: null, privacyPolicyUrl: null, termsOfServiceUrl: null,
                    defaultPrompt: null, brandColor: null,
                    composerIcon: null, composerIconUrl: null, logo: ICON, logoUrl: 'https://x/logo.png',
                    screenshots: [], screenshotUrls: ['https://x/1.png'],
                  },
                  keywords: ['docx', 'word'],
                },
                {
                  id: 'spreadsheets@openai-curated',
                  remotePluginId: null, localVersion: null, name: 'spreadsheets', shareContext: null,
                  source: { type: 'remote' },
                  installed: pluginState.spreadsheets ?? false,
                  enabled: pluginState.spreadsheets ?? false,
                  installPolicy: 'AVAILABLE', authPolicy: 'ON_USE', availability: 'AVAILABLE',
                  interface: { displayName: 'Spreadsheets', shortDescription: 'Edit spreadsheets', longDescription: null, developerName: 'OpenAI', category: 'Productivity', capabilities: [], websiteUrl: null, privacyPolicyUrl: null, termsOfServiceUrl: null, defaultPrompt: null, brandColor: null, composerIcon: null, composerIconUrl: null, logo: null, logoUrl: 'https://x/remote-only.png', screenshots: [], screenshotUrls: [] },
                  keywords: [],
                },
              ],
            },
          ],
          marketplaceLoadErrors: [{ marketplacePath: '/broken/marketplace.json', message: 'could not parse' }],
          featuredPluginIds: ['documents@openai-curated'],
        },
      })
      return

    case 'plugin/install':
      pluginState[params.pluginName] = true
      send({ id, result: { authPolicy: 'ON_USE', appsNeedingAuth: [] } })
      return

    case 'plugin/uninstall':
      pluginState[params.pluginId.split('@')[0]] = false
      send({ id, result: {} })
      return

    case 'app/list':
      send({
        id,
        result: {
          data: params.cursor ? [] : [
            { id: 'github', name: 'GitHub', description: 'Explore repositories', logoUrl: 'https://x/gh.png', logoUrlDark: null, distributionChannel: null, branding: null, appMetadata: { review: { status: 'approved' }, categories: ['Developer'], subCategories: null, seoDescription: null, screenshots: [{ url: 'https://x/gh1.png', fileId: null, userPrompt: '' }], developer: 'GitHub', version: '1', versionId: null, versionNotes: null, firstPartyType: null, firstPartyRequiresInstall: null, showInComposerWhenUnlinked: null }, labels: null, installUrl: 'https://chatgpt.com/apps/github', isAccessible: true, isEnabled: false, pluginDisplayNames: [] },
          ],
          nextCursor: null,
        },
      })
      return

    case 'mcpServerStatus/list':
      send({
        id,
        result: {
          data: [
            { name: 'github', tools: { search: {}, read: {} }, resources: [], resourceTemplates: [], authStatus: 'bearerToken' },
            { name: 'figma', tools: {}, resources: [], resourceTemplates: [], authStatus: 'notLoggedIn' },
            { name: 'local-tools', tools: { a: {}, b: {}, c: {} }, resources: [{}], resourceTemplates: [], authStatus: 'unsupported' },
          ],
          nextCursor: null,
        },
      })
      return

    case 'mcpServer/oauth/login':
      send({ id, result: { authorizationUrl: `https://auth.example/mcp/${params.name}` } })
      return

    case 'config/mcpServer/reload':
      send({ id, result: {} })
      return

    case 'permissionProfile/list':
      send({ id, result: { data: PROFILES, nextCursor: null } })
      return

    case 'collaborationMode/list':
      send({
        id,
        result: {
          data: [
            { name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'medium' },
            { name: 'Default', mode: 'default', model: null, reasoning_effort: null },
          ],
        },
      })
      return

    case 'experimentalFeature/list': {
      // Two pages, so the adapter's cursor handling is exercised.
      const page = params?.cursor === 'features-2'
        ? { data: FEATURES.slice(2), nextCursor: null }
        : { data: FEATURES.slice(0, 2), nextCursor: 'features-2' }
      send({ id, result: page })
      return
    }

    case 'experimentalFeature/enablement/set': {
      const updated = {}
      for (const [name, enabled] of Object.entries(params.enablement)) {
        const feature = FEATURES.find((entry) => entry.name === name)
        if (!feature) {
          send({ id, error: { code: -32600, message: `invalid feature enablement \`${name}\`` } })
          return
        }
        if (SILENTLY_REFUSED.has(name)) {
          send({ id, result: { enablement: {} } })
          return
        }
        if (!RUNTIME_SETTABLE.has(name)) {
          send({
            id,
            error: {
              code: -32600,
              message: `unsupported feature enablement \`${name}\`: currently supported features are ${[...RUNTIME_SETTABLE].join(', ')}`,
            },
          })
          return
        }
        feature.enabled = enabled
        updated[name] = enabled
      }
      send({ id, result: { enablement: updated } })
      return
    }

    case 'thread/list':
      send({
        id,
        result: {
          data: [
            thread(),
            thread({ id: 'thread-2', name: 'Named thread', preview: 'Another' }),
            // A thread whose first message was sent from HarnessDesk with a
            // context chip riding along: Codex stores the envelope too.
            thread({
              id: 'thread-3',
              name: null,
              preview: '<context source="Uncommitted changes">\nStatus: ## main\n</context>\n\nReply with exactly: ok',
            }),
          ],
          nextCursor: null,
          backwardsCursor: null,
        },
      })
      return

    case 'thread/search':
      send({
        id,
        result: { data: [{ thread: thread(), snippet: 'files' }], nextCursor: null, backwardsCursor: null },
      })
      return

    case 'thread/read':
      send({
        id,
        result: {
          thread: thread({
            turns: [
              {
                id: 'turn-old',
                items: [],
                // Force the adapter down the pagination path.
                itemsView: 'notLoaded',
                status: 'completed',
                error: null,
                startedAt: 1_700_000_000,
                completedAt: 1_700_000_001,
                durationMs: 1000,
              },
            ],
          }),
        },
      })
      return

    case 'thread/items/list': {
      // Two pages, so cursor handling is genuinely exercised. 0.149.0 wraps each
      // item in an entry tagged with the turn it came from.
      const entry = (item) => ({ turnId: params.turnId ?? TURN, item })
      const page = params.cursor === 'page-2'
        ? {
            data: [
              entry({
                type: 'agentMessage',
                id: 'old-2',
                text: 'second page',
                phase: null,
                memoryCitation: null,
                delivery: null,
              }),
            ],
            nextCursor: null,
            backwardsCursor: null,
          }
        : {
            data: [
              entry({
                type: 'userMessage',
                id: 'old-1',
                clientId: null,
                content: [{ type: 'text', text: 'first page', text_elements: [] }],
              }),
            ],
            nextCursor: 'page-2',
            backwardsCursor: null,
          }
      send({ id, result: page })
      return
    }

    case 'model/list':
      send({
        id,
        result: {
          data: [
            {
              id: 'gpt-5.5',
              model: 'gpt-5.5',
              upgrade: null,
              upgradeInfo: null,
              availabilityNux: null,
              displayName: 'GPT-5.5',
              description: 'Frontier model',
              hidden: false,
              supportedReasoningEfforts: [
                { reasoningEffort: 'low', description: 'fast' },
                { reasoningEffort: 'high', description: 'deep' },
              ],
              defaultReasoningEffort: 'medium',
              inputModalities: ['text', 'image'],
              supportsPersonality: true,
              additionalSpeedTiers: [],
              serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }],
              defaultServiceTier: null,
              isDefault: true,
            },
            {
              id: 'internal-only',
              model: 'internal-only',
              upgrade: null,
              upgradeInfo: null,
              availabilityNux: null,
              displayName: 'Hidden',
              description: '',
              hidden: true,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: 'medium',
              inputModalities: ['text'],
              supportsPersonality: false,
              additionalSpeedTiers: [],
              serviceTiers: [],
              defaultServiceTier: null,
              isDefault: false,
            },
          ],
          nextCursor: null,
        },
      })
      return

    case 'account/read':
      send({
        id,
        result: {
          account: signedIn ? { type: 'chatgpt', email: 'dev@example.com', planType: 'team' } : null,
          requiresOpenaiAuth: true,
        },
      })
      return

    case 'config/read':
      send({
        id,
        result: { config: { forced_login_method: forcedLoginMethod }, origins: {}, layers: null },
      })
      return

    case 'account/login/start':
      if (params.type !== 'chatgpt' && params.type !== 'chatgptDeviceCode') {
        send({ id, error: { code: -32600, message: `unsupported login type ${params.type}` } })
        return
      }
      send({ id, result: startLogin(params.type) })
      return

    case 'account/login/cancel':
      if (activeLogin?.id === params.loginId) {
        send({ id, result: { status: 'canceled' } })
        completeLogin(params.loginId, false, 'Login server error: Login was not completed')
      } else if (retiredLogins.has(params.loginId)) {
        send({ id, result: { status: 'notFound' } })
      } else {
        send({ id, error: { code: -32600, message: `invalid login id: ${params.loginId}` } })
      }
      return

    case 'account/logout':
      signedIn = false
      send({ id, result: {} })
      notify('account/updated', { authMode: null, planType: null })
      return

    case 'account/rateLimits/read':
      send({
        id,
        result: {
          rateLimits: {
            limitId: 'premium',
            limitName: null,
            // Rolling windows only when asked: most tests want a quiet footer.
            primary: process.env['FAKE_CODEX_WINDOWS']
              ? { usedPercent: 54, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600 + 19 * 60 }
              : null,
            secondary: process.env['FAKE_CODEX_WINDOWS']
              ? { usedPercent: 45, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 3 * 86400 }
              : null,
            credits: { hasCredits: false, unlimited: false, balance: '0' },
            planType: 'team',
            rateLimitReachedType: null,
          },
        },
      })
      return

    case 'turn/start': {
      THREAD = params.threadId
      TURN = `turn-${THREAD}`
      lastInput = params.input ?? null
      send({ id, result: { turn: { id: TURN, items: [], itemsView: 'full', status: 'inProgress', error: null } } })
      const said = (params.input ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(' ')
        .trim()
      const background = /^(bg|failbg|endbg)\s+(.+)$/.exec(said)
      if (background) {
        setImmediate(() => {
          notify('turn/started', {
            threadId: THREAD,
            turn: { id: TURN, items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: nowMs() },
          })
          if (background[1] === 'endbg') backgroundTerminals.delete(background[2])
          else startBackground(background[2], { fails: background[1] === 'failbg' })
          notify('turn/completed', {
            threadId: THREAD,
            turn: { id: TURN, items: [], itemsView: 'summary', status: 'completed', error: null },
          })
          notify('thread/status/changed', { threadId: THREAD, status: { type: 'idle' } })
        })
        return
      }
      if (mode === 'turn') setImmediate(playTurn)
      if (mode === 'dynamic-tools') setImmediate(callDeclaredTool)
      return
    }

    case 'thread/backgroundTerminals/list':
      send({ id, result: { data: [...backgroundTerminals.values()], nextCursor: null } })
      return

    case 'thread/backgroundTerminals/terminate': {
      const had = backgroundTerminals.delete(params.processId)
      send({ id, result: { terminated: had } })
      return
    }

    case 'thread/backgroundTerminals/clean':
      send({ id, result: {} })
      return

    case 'turn/interrupt':
      send({ id, result: {} })
      notify('turn/completed', {
        threadId: THREAD,
        turn: { id: params.turnId, items: [], itemsView: 'summary', status: 'interrupted', error: null },
      })
      return

    case 'turn/steer':
      // Mirror Codex's precondition so a wrong turn id is a visible failure.
      if (params.expectedTurnId !== TURN) {
        send({ id, error: { code: -32000, message: 'active turn does not match expectedTurnId' } })
        return
      }
      send({ id, result: {} })
      return

    case 'thread/name/set':
      send({ id, result: {} })
      notify('thread/name/updated', { threadId: THREAD, threadName: params.name })
      return

    default:
      send({ id, result: {} })
  }
})

process.stdin.on('close', () => process.exit(0))

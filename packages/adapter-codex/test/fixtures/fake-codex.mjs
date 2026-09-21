#!/usr/bin/env node
/**
 * A scripted `codex` stand-in that plays a realistic turn.
 *
 * Exists so the adapter's end-to-end path — spawn, handshake, thread start, turn
 * streaming, approval round-trip, interrupt — is exercised against a real
 * process over real pipes, without credentials, network, or credits.
 */

import readline from 'node:readline'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// A real file on disk, so the adapter's icon inlining is exercised rather than
// mocked. Codex resolves an installed package's icon to an absolute path.
const ICON = fileURLToPath(new URL('./plugin-icon.svg', import.meta.url))

/* The build this stand-in plays. `FAKE_CODEX_VERSION_FILE` names a file holding
   the version, read each time the process starts: a rig upgrades "Codex" under
   a desk that is already running — a process whose environment cannot change —
   by writing the file, and the next `--version` and the next app-server are the
   new build. Without the file, the variable; without either, 0.149.0. */
const versionFile = process.env['FAKE_CODEX_VERSION_FILE']
const installed = versionFile && existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : ''
const version = installed || (process.env['FAKE_CODEX_VERSION'] ?? '0.149.0')
const mode = process.env['FAKE_CODEX_MODE'] ?? 'turn'
/** Whether the release played is `0.<minor>.0` or later, for what arrived with one. */
const since = (minor) => Number(version.split('.')[1]) >= minor

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

const thread = (overrides = {}) => {
  const described = {
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
  }
  // How Codex keeps this thread's history, which it reports on every thread.
  return { historyMode: historyOf(described.id).mode, ...described }
}

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
  // With no profile active, the sandbox is a mode over the thread's
  // `[sandbox_workspace_write]` configuration, or a policy set whole.
  sandboxMode: 'workspace-write',
  sandboxConfig: { writable_roots: ['/w'], network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false },
  sandboxPolicy: null,
  model: 'gpt-5.5',
  serviceTier: null,
  // FAKE_CODEX_CONFIGURED_EFFORT is `model_reasoning_effort` in config.toml.
  effort: process.env['FAKE_CODEX_CONFIGURED_EFFORT'] ?? null,
  mode: 'default',
  modelProvider: 'openai',
  contextWindow: 272000,
  workspaceRoots: ['/w'],
}
/**
 * What the configuration gives a thread nobody said anything about. A new
 * thread starts here, as a real one starts from `config.toml`, never from
 * whatever the last thread was changed to — which is what lets a test tell
 * a setting carried across from one that was never lost.
 */
const CONFIGURED = { ...settingsState }
const ADDITIONAL_MODEL = process.env['FAKE_CODEX_ADDITIONAL_MODEL'] ?? null
const sandboxPolicy = () => {
  if (settingsState.permissions) return SANDBOX_FOR_PROFILE[settingsState.permissions] ?? SANDBOX_FOR_PROFILE[':workspace']
  if (settingsState.sandboxPolicy) return settingsState.sandboxPolicy
  const written = settingsState.sandboxConfig
  switch (settingsState.sandboxMode) {
    case 'read-only':
      return { type: 'readOnly', networkAccess: false }
    case 'danger-full-access':
      return { type: 'dangerFullAccess' }
    default:
      return {
        type: 'workspaceWrite',
        writableRoots: [...written.writable_roots],
        networkAccess: written.network_access,
        excludeTmpdirEnvVar: written.exclude_tmpdir_env_var,
        excludeSlashTmp: written.exclude_slash_tmp,
      }
  }
}

const threadSettings = () => ({
  cwd: settingsState.cwd,
  approvalPolicy: settingsState.approvalPolicy,
  approvalsReviewer: settingsState.approvalsReviewer,
  sandboxPolicy: sandboxPolicy(),
  activePermissionProfile: settingsState.permissions ? { id: settingsState.permissions, extends: null } : null,
  model: settingsState.model,
  modelProvider: settingsState.modelProvider,
  serviceTier: settingsState.serviceTier,
  effort: settingsState.effort,
  summary: null,
  collaborationMode: {
    mode: settingsState.mode,
    settings: { model: settingsState.model, reasoning_effort: settingsState.effort, developer_instructions: null },
  },
  personality: 'pragmatic',
})

/**
 * FAKE_CODEX_EFFORT_SETTLES=high:low settles an effort somewhere other than
 * where it was asked to go — asked for high, the thread runs at low — and says
 * so only where Codex says anything, in `thread/settings/updated`. The answer
 * to the update is `{}` either way. Real Codex has not been seen doing this; a
 * desk that reads back what it asked for would not notice if it did.
 */
const EFFORT_SETTLES = Object.fromEntries(
  (process.env['FAKE_CODEX_EFFORT_SETTLES'] ?? '')
    .split(',')
    .filter(Boolean)
    .map((pair) => pair.split(':')),
)

/** Applies thread-verb params (start/resume/fork) or settings-update params. Returns an error message or null. */
const applySettings = (params, { sandboxKey }) => {
  if (params.permissions != null && params[sandboxKey] != null) {
    return `\`permissions\` cannot be combined with \`${sandboxKey}\``
  }
  if (params.permissions != null && !PROFILES.some((p) => p.id === params.permissions)) {
    return 'failed to load configuration: default_permissions requires a `[permissions]` table'
  }
  if (params.model != null) settingsState.model = params.model
  if (params.modelProvider != null) settingsState.modelProvider = params.modelProvider
  if (params.runtimeWorkspaceRoots != null) settingsState.workspaceRoots = [...params.runtimeWorkspaceRoots]
  // `sandbox_workspace_write.*` keys in a thread verb's `config` stand in for
  // config.toml's own, as they do in Codex.
  for (const [key, value] of Object.entries(params.config ?? {})) {
    if (key === 'model_context_window' && typeof value === 'number') settingsState.contextWindow = value
    const field = /^sandbox_workspace_write\.(.+)$/.exec(key)?.[1]
    if (field) settingsState.sandboxConfig = { ...settingsState.sandboxConfig, [field]: value }
  }
  if (params.permissions != null) settingsState.permissions = params.permissions
  if (sandboxKey === 'sandbox' && params.sandbox != null) {
    settingsState.permissions = null
    settingsState.sandboxMode = params.sandbox
    settingsState.sandboxPolicy = null
  }
  if (sandboxKey === 'sandboxPolicy' && params.sandboxPolicy != null) {
    /* Measured on 0.145.0 and 0.155.0: a workspace policy given to a thread
       with no profile active gains the thread's configured writable roots,
       first; any other policy, or one given over a profile, is taken as it
       came. */
    const given = params.sandboxPolicy
    settingsState.sandboxPolicy =
      given.type === 'workspaceWrite' && settingsState.permissions === null
        ? { ...given, writableRoots: [...new Set([...settingsState.sandboxConfig.writable_roots, ...given.writableRoots])] }
        : given
    settingsState.permissions = null
  }
  if (params.approvalPolicy != null) settingsState.approvalPolicy = params.approvalPolicy
  if (params.approvalsReviewer != null) settingsState.approvalsReviewer = params.approvalsReviewer
  if (params.serviceTier !== undefined) settingsState.serviceTier = params.serviceTier
  if (params.effort !== undefined) {
    settingsState.effort = Object.hasOwn(EFFORT_SETTLES, String(params.effort)) ? EFFORT_SETTLES[params.effort] : params.effort
  }
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
  modelProvider: settingsState.modelProvider,
  serviceTier: settingsState.serviceTier,
  cwd: settingsState.cwd,
  runtimeWorkspaceRoots: [...settingsState.workspaceRoots],
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
const deletedThreads = new Set()

/**
 * What Codex has stored: what `thread/list` returns, and what `thread/read`
 * answers for each of them.
 */
const storedThreads = () => [
  thread(),
  thread({ id: 'thread-2', name: 'Named thread', preview: 'Another' }),
  // A thread whose first message was sent from HarnessDesk with a context
  // chip riding along: Codex stores the envelope too.
  thread({
    id: 'thread-3',
    name: null,
    preview: '<context source="Uncommitted changes">\nStatus: ## main\n</context>\n\nReply with exactly: ok',
  }),
  // A first message that is nothing but blocks, the adapter's own Git
  // preamble ahead of the chip the person attached.
  thread({
    id: 'thread-4',
    name: null,
    preview:
      '<context source="Git">\nOn branch main.\n</context>\n\n<context source="Uncommitted changes">\nStatus: ## main\n</context>',
  }),
].filter((t) => !deletedThreads.has(t.id))

/**
 * What Codex has stored of each thread's history, kept the two ways Codex
 * keeps one (the adapter's `history.ts`; measured on 0.145.0 and 0.155.0 with
 * `script/probe/paginated-history.mjs`):
 *
 * - `paginated`, every thread Codex starts from 0.151.0: paged by
 *   `thread/turns/list` and `thread/items/list`, undone by `thread/revert`
 *   (from 0.148.0), refused `thread/rollback`, and read whole only with a
 *   `deprecationNotice` — from 0.151.0; before, not at all;
 * - `legacy`, every thread before 0.151.0: read whole, undone by
 *   `thread/rollback`, refused `thread/items/list` and `thread/revert`.
 *
 * The four listed threads keep the one turn they have always read back as, in
 * the mode the release played starts threads in. Two more are listed nowhere
 * and read by id: `thread-paged`, three turns kept in pages, and
 * `thread-legacy`, two kept whole — one conversation from each side of
 * 0.151.0, whichever release this is. A thread started here has nothing
 * stored, and nothing the fake plays on one is stored either: a test that
 * reads, forks or undoes a history reads one of these.
 */
const NEW_HISTORY = since(151) ? 'paginated' : 'legacy'
/** Codex's own words, for every client but its terminal (0.155.0 `thread_processor.rs`). */
const DEPRECATED = {
  rollback: 'thread/rollback is deprecated and will be removed soon',
  read: 'Full-history hydration is deprecated for paginated threads; omit `includeTurns` or set it to `false`, then page with `thread/turns/list` and `thread/items/list`.',
  resume: 'Full-history hydration is deprecated for paginated threads; use `excludeTurns: true`, then page with `thread/turns/list` and `thread/items/list`.',
}
const pastTurn = (id, items, startedAt) => ({ id, items, itemsView: 'full', status: 'completed', error: null, startedAt, completedAt: startedAt + 4, durationMs: 4000 })
const asked = (id, text) => ({ type: 'userMessage', id, clientId: null, content: [{ type: 'text', text, text_elements: [] }] })
const answered = (id, text) => ({ type: 'agentMessage', id, text, phase: null, memoryCitation: null, delivery: null })
const histories = new Map([
  ...['thread-e2e', 'thread-2', 'thread-3', 'thread-4'].map((id) => [
    id,
    { mode: NEW_HISTORY, stored: true, turns: [pastTurn('turn-old', [asked('old-1', 'first page'), answered('old-2', 'second page')], 1_700_000_000)] },
  ]),
  ['thread-paged', {
    mode: 'paginated',
    stored: true,
    turns: [
      pastTurn('turn-p1', [asked('p1-ask', 'What is in here?'), answered('p1-answer', 'A README and a src folder.')], 1_700_000_200),
      pastTurn('turn-p2', [
        asked('p2-ask', 'Run the tests.'),
        { type: 'commandExecution', id: 'p2-run', command: 'npm test', cwd: '/w', processId: null, source: 'agent', status: 'completed', commandActions: [{ type: 'unknown', command: 'npm test' }], aggregatedOutput: '3 passing\n', exitCode: 0, durationMs: 900 },
        answered('p2-answer', 'All three pass.'),
      ], 1_700_000_300),
      pastTurn('turn-p3', [asked('p3-ask', 'Write it up.'), answered('p3-answer', 'Done, in NOTES.md.')], 1_700_000_400),
    ],
  }],
  ['thread-legacy', {
    mode: 'legacy',
    stored: true,
    turns: [
      pastTurn('turn-l1', [asked('l1-ask', 'Say hello.'), answered('l1-answer', 'Hello.')], 1_700_000_500),
      pastTurn('turn-l2', [asked('l2-ask', 'Say goodbye.'), answered('l2-answer', 'Goodbye.')], 1_700_000_600),
    ],
  }],
])
/** A thread's history. A thread nothing is stored for yet — one started here — is empty. */
const historyOf = (threadId) => {
  if (!histories.has(threadId)) histories.set(threadId, { mode: NEW_HISTORY, stored: false, turns: [] })
  return histories.get(threadId)
}
/**
 * Codex's words for a thread with nothing stored, which has had no first
 * message. 0.155.0 has two, measured: this, and — for a thread it holds live,
 * depending on what its store already has — "list_turns is not supported
 * yet", which FAKE_CODEX_UNSTORED=list_turns plays.
 */
const unmaterialized = (threadId, what) =>
  process.env['FAKE_CODEX_UNSTORED'] === 'list_turns'
    ? { code: -32601, message: 'list_turns is not supported yet' }
    : { code: -32600, message: `thread ${threadId} is not materialized yet; ${what} is unavailable before first user message` }
/**
 * FAKE_CODEX_CHANGE_BETWEEN_LISTINGS plays another client writing the thread
 * while it is being read, as the items of the whole thread start to be listed
 * — after its turns were. Once per thread: `append` starts a turn (with its
 * items), `revert` reverts the newest one away, `grow` gives the newest one
 * another item. `append-always` starts a turn at every such listing, a
 * history that never holds still for a read.
 */
const changedBetweenListings = new Set()
let lateTurns = 0
const changeBetweenListings = (threadId, history) => {
  const change = process.env['FAKE_CODEX_CHANGE_BETWEEN_LISTINGS']
  if (!change || (change !== 'append-always' && changedBetweenListings.has(threadId))) return
  changedBetweenListings.add(threadId)
  if (change === 'revert') {
    history.turns = history.turns.slice(0, -1)
  } else if (change === 'grow') {
    const newest = history.turns.at(-1)
    history.turns = [...history.turns.slice(0, -1), { ...newest, items: [...newest.items, answered(`${newest.id}-more`, 'And one more thing.')] }]
  } else {
    lateTurns += 1
    history.turns = [...history.turns, pastTurn(`turn-late-${lateTurns}`, [asked(`late-${lateTurns}-ask`, 'One more thing.'), answered(`late-${lateTurns}-answer`, 'Done.')], 1_700_000_900 + lateTurns)]
  }
}
/** FAKE_CODEX_FAIL_TURNS_LISTS=<n> refuses the first n turn listings, as a store that cannot be read does. */
let turnListingsFailed = 0
/**
 * One page of a listing: at most `limit`, clamped as Codex clamps it and then
 * to two, so every cursor gets followed; ordered by `sortDirection`, else by
 * the listing's own default. The cursor is opaque to the client, as Codex's is.
 */
const pageOf = (entries, params, direction, scope) => {
  const ordered = (params.sortDirection ?? direction) === 'desc' ? [...entries].reverse() : entries
  const from = params.cursor ? JSON.parse(params.cursor).from : 0
  const size = Math.min(Math.max(params.limit ?? 25, 1), 100, 2)
  const data = ordered.slice(from, from + size)
  return {
    data,
    nextCursor: from + size < ordered.length ? JSON.stringify({ scope, from: from + size }) : null,
    backwardsCursor: data.length > 0 ? JSON.stringify({ scope, from, anchor: true }) : null,
  }
}
/**
 * What `thread/resume` and `thread/fork` do with a history before they answer.
 * A fork keeps its source's history, kept the same way; a Codex before
 * 0.151.0 cannot fork a paginated one at all. Either verb asked for the turns
 * of a paginated thread says Codex has deprecated that — the turns themselves
 * are not sent, since nothing here asks for them any more. Returns a refusal,
 * or null.
 */
const historyVerb = (method, params) => {
  const source = historyOf(params.threadId)
  if (method === 'thread/fork') {
    if (source.mode === 'paginated' && !since(151)) return { code: -32601, message: 'paginated_threads is not supported yet' }
    histories.set(THREAD, { mode: source.mode, stored: source.stored, turns: source.turns.map((turn) => ({ ...turn })) })
  }
  if (!params.excludeTurns && source.mode === 'paginated' && since(151)) {
    notify('deprecationNotice', { summary: DEPRECATED.resume, details: null })
  }
  return null
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
  return { total: { ...runningTotal }, last, modelContextWindow: settingsState.contextWindow }
}

let turnStartedAt = nowSeconds()

const openingUserItem = () => ({
  type: 'userMessage',
  id: 'item-u1',
  content:
    Array.isArray(lastInput) && lastInput.length > 0
      ? lastInput.map((part) => (part.type === 'text' ? { ...part, text_elements: part.text_elements ?? [] } : part))
      : [{ type: 'text', text: 'List the files here.', text_elements: [] }],
})

const turnOpening = () => {
  turnStartedAt = nowSeconds()
  const userItem = openingUserItem()
  return [
    {
      method: 'turn/started',
      params: {
        threadId: THREAD,
        turn: { id: TURN, items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: turnStartedAt },
      },
    },
    { method: 'thread/status/changed', params: { threadId: THREAD, status: { type: 'active', activeFlags: [] } } },
    { method: 'item/started', params: { threadId: THREAD, turnId: TURN, item: userItem, startedAtMs: nowMs() } },
    { method: 'item/completed', params: { threadId: THREAD, turnId: TURN, item: userItem, completedAtMs: nowMs() } },
  ]
}

const playTurn = (openingAlreadySent = false) => {
  if (!openingAlreadySent) {
    for (const message of turnOpening()) send(message)
  }

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

/**
 * An inline review, notification for notification as 0.155.0 plays one
 * (`script/probe/review-side-thread.mjs --shapes`; 0.145.0 is the same):
 *
 * - no `turn/started` for the review's own turn, whose id the answer, every
 *   item and the `turn/completed` carry;
 * - a `turn/started` under another id — the reviewer sub-agent's, forwarded —
 *   which nothing names again;
 * - an `agentMessage` the reviewer began, started and never completed,
 *   because Codex withholds the reviewer's words for the findings it renders.
 *
 * FAKE_CODEX_REVIEW_MS holds the review open that long before its findings,
 * for a caller that has to see it working, or stop it; 20 ms otherwise.
 * Stopping one is Codex's way too: `turn/interrupt` has to name the
 * reviewer's turn, or no turn at all, never the review's (`stopReview`).
 * FAKE_CODEX_REVIEWER_MS holds back the reviewer's `turn/started` that long,
 * and FAKE_CODEX_REVIEWER_FIRST=1 sends it before the review's first item —
 * neither is what either Codex does, and the adapter must not care.
 * FAKE_CODEX_REVIEWER_UNANNOUNCED=1 starts the reviewer without forwarding
 * its `turn/started` at all, and FAKE_CODEX_NO_STARTUP_INTERRUPT=1 checks a
 * stop naming no turn like any other: a Codex neither version is, which the
 * adapter must still be able to stop.
 */
let reviews = 0
/** Per thread, the review running on it: its turn, the reviewer's, and the timer that ends it. */
const runningReviews = new Map()
const playReview = (id, params) => {
  reviews += 1
  const threadId = params.threadId
  const turnId = `review-turn-${reviews}`
  const reviewerTurnId = `reviewer-turn-${reviews}`
  const hint = params.target.type === 'uncommittedChanges' ? 'current changes' : params.target.type
  const on = (method, item, at) => notify(method, { threadId, turnId, item, ...at })
  send({
    id,
    result: {
      turn: {
        id: turnId,
        items: [{ type: 'userMessage', id: turnId, clientId: null, content: [{ type: 'text', text: hint, text_elements: [] }] }],
        itemsView: 'notLoaded',
        status: 'inProgress',
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      },
      reviewThreadId: threadId,
    },
  })
  const startedAtMs = nowMs()
  const review = { turnId, reviewerTurnId, reviewerStarted: false, reviewerTimer: null, timer: null, reviews, startedAtMs }
  const reviewerStarts = () => {
    review.reviewerStarted = true
    if (process.env['FAKE_CODEX_REVIEWER_UNANNOUNCED'] === '1') return
    notify('turn/started', {
      threadId,
      turn: { id: reviewerTurnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: Math.floor(startedAtMs / 1000), completedAt: null, durationMs: null },
    })
  }
  const first = process.env['FAKE_CODEX_REVIEWER_FIRST'] === '1'
  if (first) reviewerStarts()
  const entered = { type: 'enteredReviewMode', id: `entered-${reviews}`, review: hint }
  on('item/started', entered, { startedAtMs: nowMs() })
  on('item/completed', entered, { completedAtMs: nowMs() })
  notify('thread/status/changed', { threadId, status: { type: 'active', activeFlags: [] } })
  const lag = Number(process.env['FAKE_CODEX_REVIEWER_MS'] ?? 0)
  if (!first && lag > 0) review.reviewerTimer = setTimeout(reviewerStarts, lag)
  else if (!first) reviewerStarts()
  const asked = {
    type: 'userMessage',
    id: `asked-${reviews}`,
    clientId: null,
    content: [{ type: 'text', text: 'Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.', text_elements: [] }],
  }
  on('item/started', asked, { startedAtMs: nowMs() })
  on('item/completed', asked, { completedAtMs: nowMs() })
  on('item/started', { type: 'agentMessage', id: `withheld-${reviews}`, text: '', phase: null, memoryCitation: null, delivery: null, questions: null }, { startedAtMs: nowMs() })
  review.timer = setTimeout(() => {
    runningReviews.delete(threadId)
    clearTimeout(review.reviewerTimer)
    const findings = 'One cosmetic finding.\n\nReview comment:\n\n- [P2] Greeting lost its punctuation — README.md:1-1\n  The edit drops the full stop the other lines keep.'
    const exited = { type: 'exitedReviewMode', id: `exited-${reviews}`, review: findings }
    on('item/started', exited, { startedAtMs: nowMs() })
    on('item/completed', exited, { completedAtMs: nowMs() })
    const answer = { type: 'agentMessage', id: `findings-${reviews}`, text: findings, phase: null, memoryCitation: null, delivery: null, questions: null }
    on('item/started', answer, { startedAtMs: nowMs() })
    on('item/completed', answer, { completedAtMs: nowMs() })
    notify('thread/status/changed', { threadId, status: { type: 'idle' } })
    // Timed from the reviewer's start, as Codex times it.
    notify('turn/completed', {
      threadId,
      turn: { id: turnId, items: [answer], itemsView: 'summary', status: 'completed', error: null, startedAt: Math.floor(startedAtMs / 1000), completedAt: nowSeconds(), durationMs: nowMs() - startedAtMs },
    })
  }, Number(process.env['FAKE_CODEX_REVIEW_MS'] ?? 20))
  runningReviews.set(threadId, review)
}

/**
 * `turn/interrupt` on a thread with a review running, measured on 0.145.0
 * and 0.155.0: Codex checks a named turn against the one it holds as
 * running — the reviewer's, and before the reviewer has started, none —
 * while a stop naming no turn is its "startup interrupt" and is not checked.
 * The refusals are Codex's words. The stopped review then ends under its own
 * turn.
 */
const stopReview = (id, params) => {
  const review = runningReviews.get(params.threadId)
  const checked = params.turnId !== '' || process.env['FAKE_CODEX_NO_STARTUP_INTERRUPT'] === '1'
  if (checked && !review.reviewerStarted) {
    send({ id, error: { code: -32600, message: 'no active turn to interrupt' } })
    return
  }
  if (checked && params.turnId !== review.reviewerTurnId) {
    send({ id, error: { code: -32600, message: `expected active turn id ${params.turnId} but found ${review.reviewerTurnId}` } })
    return
  }
  clearTimeout(review.timer)
  clearTimeout(review.reviewerTimer)
  runningReviews.delete(params.threadId)
  send({ id, result: {} })
  const on = (method, item, at) => notify(method, { threadId: params.threadId, turnId: review.turnId, item, ...at })
  const exited = { type: 'exitedReviewMode', id: `exited-${review.reviews}`, review: 'Reviewer failed to output a response.' }
  on('item/started', exited, { startedAtMs: nowMs() })
  on('item/completed', exited, { completedAtMs: nowMs() })
  const said = { type: 'agentMessage', id: `stopped-${review.reviews}`, text: 'Review was interrupted. Please re-run /review and wait for it to complete.', phase: null, memoryCitation: null, delivery: null, questions: null }
  on('item/started', said, { startedAtMs: nowMs() })
  on('item/completed', said, { completedAtMs: nowMs() })
  notify('thread/status/changed', { threadId: params.threadId, status: { type: 'idle' } })
  notify('turn/completed', {
    threadId: params.threadId,
    turn: { id: review.turnId, items: [], itemsView: 'notLoaded', status: 'interrupted', error: null, startedAt: Math.floor(review.startedAtMs / 1000), completedAt: nowSeconds(), durationMs: nowMs() - review.startedAtMs },
  })
}

/**
 * A user verification, the elicitation mode 0.155.0 added: an MCP server
 * asking Codex to have the person sign a challenge with a key enrolled on the
 * device. Real Codex routes one only to its own in-process terminal UI and
 * cancels it for every other client; the fake asks anyone who says
 * `verify <title>`, so the client's answer can be seen. The turn then ends
 * with the agent saying what came back.
 */
const verifications = new Map()

const askVerification = (title) => {
  notify('turn/started', {
    threadId: THREAD,
    turn: { id: TURN, items: [], itemsView: 'full', status: 'inProgress', error: null, startedAt: nowSeconds() },
  })
  const asked = {
    type: 'userMessage',
    id: 'item-v0',
    content: (lastInput ?? []).map((part) => (part.type === 'text' ? { ...part, text_elements: part.text_elements ?? [] } : part)),
  }
  notify('item/started', { threadId: THREAD, turnId: TURN, item: asked, startedAtMs: nowMs() })
  notify('item/completed', { threadId: THREAD, turnId: TURN, item: asked, completedAtMs: nowMs() })
  const id = ++approvalRequestId
  verifications.set(id, THREAD)
  send({
    id,
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: THREAD,
      turnId: TURN,
      serverName: 'payments',
      mode: 'openai/userVerification',
      title,
      description: 'Approve it with the key enrolled on this device.',
      challenge: 'c2lnbi1tZQ',
    },
  })
}

const answerVerification = (message) => {
  THREAD = verifications.get(message.id)
  TURN = `turn-${THREAD}`
  verifications.delete(message.id)
  const outcome = message.error
    ? `as error ${message.error.code}`
    : `"${message.result?.action}" with ${message.result?.content == null ? 'nothing signed' : 'content'}`
  const item = { type: 'agentMessage', id: 'item-v1', text: `The verification came back ${outcome}.`, phase: null, memoryCitation: null }
  notify('item/started', { threadId: THREAD, turnId: TURN, item: { ...item, text: '' }, startedAtMs: nowMs() })
  notify('item/completed', { threadId: THREAD, turnId: TURN, item, completedAtMs: nowMs() })
  notify('turn/completed', {
    threadId: THREAD,
    turn: { id: TURN, items: [], itemsView: 'summary', status: 'completed', error: null },
  })
  notify('thread/status/changed', { threadId: THREAD, status: { type: 'idle' } })
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
  const completedItems = process.env['FAKE_CODEX_FULLER_COMPLETION'] === '1'
    ? [
        openingUserItem(),
        answered('item-a1', 'Running ls.'),
        answered('item-a2', 'The command completed.'),
        answered('item-a3', 'Done.'),
      ]
    : []
  notify('turn/completed', {
    threadId: THREAD,
    turn: {
      id: TURN,
      items: completedItems,
      itemsView: completedItems.length > 0 ? 'full' : 'summary',
      status: 'completed',
      error: null,
      startedAt: turnStartedAt,
      completedAt: nowSeconds(),
      durationMs: 5000,
    },
  })
  if (process.env['FAKE_CODEX_PERSIST_TURN'] === '1') {
    const history = historyOf(THREAD)
    history.stored = true
    history.turns = [pastTurn(TURN, completedItems.length > 0 ? completedItems : [openingUserItem()], turnStartedAt)]
  }
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

/** A child thread calls the first client-declared tool after naming its parent. */
const callDeclaredToolAsChild = () => {
  const tool = declaredTools[0]
  if (!tool) {
    notify('warning', { threadId: THREAD, message: 'TOOLS_DECLARED (none)' })
    return
  }
  const child = `${THREAD}-child`
  notify('thread/started', { thread: thread({ id: child, parentThreadId: THREAD, preview: 'A sub-agent.' }) })
  send({
    id: ++approvalRequestId,
    method: 'item/tool/call',
    params: {
      threadId: child,
      turnId: 'turn-child',
      callId: 'call-dyn-child',
      namespace: tool.namespace ?? null,
      tool: tool.name,
      arguments: { text: 'from a sub-agent' },
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
    // Answered with a result or refused with an error, a verification ends
    // its turn the same way; only what the agent says differs.
    if (verifications.has(message.id)) {
      answerVerification(message)
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
  const laneEnvironment = params?.config?.['shell_environment_policy.set']
  if (
    process.env.FAKE_CODEX_LANE_ENV_LOG &&
    ['thread/start', 'thread/resume', 'thread/fork'].includes(method) &&
    laneEnvironment
  ) {
    const keys = [
      'HARNESSDESK_GOAL_ID',
      'HARNESSDESK_LANE_ID',
      'HARNESSDESK_PORT_START',
      'HARNESSDESK_PORT_END',
      'HARNESSDESK_PORT_COUNT',
      'PORT',
    ]
    const source = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key]]))))`
    const child = spawnSync(process.execPath, ['-e', source], {
      env: { ...process.env, ...laneEnvironment },
      encoding: 'utf8',
    })
    if (child.status !== 0) throw new Error('The lane fixture child failed.')
    appendFileSync(
      process.env.FAKE_CODEX_LANE_ENV_LOG,
      `${JSON.stringify({ method, environment: laneEnvironment, child: JSON.parse(child.stdout) })}\n`,
    )
  }

  // FAKE_CODEX_FOLDERS=<file> records which folder each configuration read was
  // asked about, one JSON line each — null for one asked about none.
  if (process.env['FAKE_CODEX_FOLDERS'] && (method === 'config/read' || method === 'permissionProfile/list')) {
    appendFileSync(process.env['FAKE_CODEX_FOLDERS'], `${JSON.stringify({ method, cwd: params?.cwd ?? null })}\n`)
  }

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
      // Nothing stored yet, even under an id the fake has handed out before;
      // kept the way this release keeps a new thread unless asked otherwise,
      // and an ephemeral one is never paged.
      histories.set(THREAD, { mode: params?.historyMode ?? (params?.ephemeral ? 'legacy' : NEW_HISTORY), stored: false, turns: [] })
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
      Object.assign(settingsState, CONFIGURED)
      const problem = applySettings(params ?? {}, { sandboxKey: 'sandbox' })
      if (problem) {
        send({ id, error: { code: -32600, message: problem } })
        return
      }
      // A new thread is in the folder it was started in, as Codex reports it.
      send({ id, result: { ...startResponse(), thread: thread({ preview: '', cwd: settingsState.cwd }) } })
      notify('thread/started', { thread: thread() })
      notify('warning', {
        threadId: THREAD,
        message: `TOOLS_DECLARED ${declaredTools.map((t) => (t.namespace ? `${t.namespace}/${t.name}` : t.name)).join(',') || '(none)'}`,
      })
      // FAKE_CODEX_ECHO_STARTS=1 says what the thread was started with, the
      // way a test reads a request. Off by default: it is a toast in the app.
      if (process.env['FAKE_CODEX_ECHO_STARTS'] === '1') {
        notify('warning', {
          threadId: THREAD,
          message: `STARTED ${JSON.stringify({ ...params, dynamicTools: undefined, developerInstructions: undefined })}`,
        })
      }
      return
    }

    case 'thread/resume':
    case 'thread/fork': {
      if (deletedThreads.has(params?.threadId)) {
        send({ id, error: { code: -32600, message: `thread ${params.threadId} not found` } })
        return
      }
      THREAD = method === 'thread/resume' ? params.threadId : nextThreadId()
      TURN = `turn-${THREAD}`
      const refused = historyVerb(method, params)
      if (refused) {
        send({ id, error: refused })
        return
      }
      const problem = applySettings(params ?? {}, { sandboxKey: 'sandbox' })
      if (problem) {
        send({ id, error: { code: -32600, message: problem } })
        return
      }
      /* FAKE_CODEX_RESUMED_SANDBOX is a policy another client put the thread
         under, which it is resumed in: JSON, as Codex reports one. */
      const resumed = process.env['FAKE_CODEX_RESUMED_SANDBOX']
      if (method === 'thread/resume' && resumed && params?.permissions == null && params?.sandbox == null) {
        settingsState.permissions = null
        settingsState.sandboxPolicy = JSON.parse(resumed)
      }
      send({ id, result: startResponse() })
      notify('thread/started', { thread: thread() })
      return
    }

    case 'thread/memoryMode/set':
      notify('warning', { threadId: params.threadId, message: `MEMORY ${params.mode}` })
      send({ id, result: {} })
      return

    case 'thread/rollback': {
      // Said to every client but Codex's own terminal, before anything else.
      notify('deprecationNotice', { summary: DEPRECATED.rollback, details: null })
      const history = historyOf(params.threadId)
      if (history.mode === 'paginated') {
        send({ id, error: { code: -32600, message: 'paginated threads do not support thread/rollback' } })
        return
      }
      if (!(params.numTurns >= 1)) {
        send({ id, error: { code: -32600, message: 'numTurns must be >= 1' } })
        return
      }
      if (!history.stored) {
        send({ id, error: { code: -32600, message: 'failed to load thread history for rollback replay: invalid thread-store request: failed to resolve rollout path: file does not exist' } })
        return
      }
      // More turns than there are drops them all.
      history.turns = history.turns.slice(0, Math.max(0, history.turns.length - params.numTurns))
      send({ id, result: { thread: thread({ id: params.threadId, turns: history.turns }) } })
      return
    }

    case 'thread/revert': {
      if (!since(148)) {
        // Codex's refusal lists every method it knows; the head of it is enough.
        send({ id, error: { code: -32600, message: 'Invalid request: unknown variant `thread/revert`, expected one of `initialize`, `thread/start`, `thread/resume`, `thread/fork`, `thread/rollback`, `thread/read`, `thread/turns/list`, `thread/items/list`' } })
        return
      }
      const history = historyOf(params.threadId)
      if (history.mode !== 'paginated') {
        send({ id, error: { code: -32600, message: 'thread/revert only supports paginated threads' } })
        return
      }
      if (!history.stored) {
        send({ id, error: { code: -32603, message: `failed to revert session: thread ${params.threadId} not found` } })
        return
      }
      const at = history.turns.findIndex((turn) => turn.id === params.beforeTurnId)
      if (at === -1) {
        send({ id, error: { code: -32600, message: `turn not found: ${params.beforeTurnId}` } })
        return
      }
      // The turn named and every one after it go; the thread is reloaded
      // behind the call and answers with no turns of its own.
      history.turns = history.turns.slice(0, at)
      send({
        id,
        result: {
          thread: thread({ id: params.threadId }),
          turnsBackwardsCursor: history.turns.length > 0 ? JSON.stringify({ scope: 'turns', from: 0, anchor: true }) : null,
          itemsBackwardsCursor: history.turns.length > 0 ? JSON.stringify({ scope: 'items', from: 0, anchor: true }) : null,
        },
      })
      notify('thread/reverted', { threadId: params.threadId })
      return
    }

    case 'thread/compact/start':
      send({ id, result: {} })
      notify('thread/compacted', { threadId: params.threadId })
      return

    case 'review/start':
      notify('warning', { threadId: params.threadId, message: `REVIEW ${params.target.type} ${params.delivery ?? 'default'}` })
      if (params.delivery === 'detached') {
        /* 0.155.0's answer, measured: every detached review is deprecated out
           loud, and one on a thread with paginated history — every thread
           0.155.0 starts — is then refused. */
        notify('deprecationNotice', {
          summary: 'review/start with delivery "detached" is deprecated and will be removed in a future release.',
          details:
            'Use thread/start followed by review/start with delivery "inline" for a separate review thread, or thread/fork followed by turn/start with your own review instructions.',
        })
        send({ id, error: { code: -32600, message: 'paginated threads do not support detached review' } })
        return
      }
      // Codex's own check, word for word (`review_request_from_target`).
      if (params.target.type === 'baseBranch' && !params.target.branch.trim()) {
        send({ id, error: { code: -32600, message: 'branch must not be empty' } })
        return
      }
      playReview(id, params)
      return

    case 'thread/settings/update': {
      const was = JSON.stringify(threadSettings())
      const problem = applySettings(params, { sandboxKey: 'sandboxPolicy' })
      if (problem) {
        send({ id, error: { code: -32600, message: problem } })
        return
      }
      /* FAKE_CODEX_QUIET_NOOP=1 is real Codex's way, measured on 0.149.0: an
         update that changes nothing is answered `{}` and never announced. */
      if (process.env['FAKE_CODEX_QUIET_NOOP'] === '1' && JSON.stringify(threadSettings()) === was) {
        send({ id, result: {} })
        return
      }
      /* FAKE_CODEX_SETTINGS_ORDER is where the announcement falls against the
         answer, since a reader must hold Codex's word whichever comes first:
         `answer-first` (the answer alone, the announcement in a later read —
         0.149.0 writes it a millisecond after), `one-chunk` (both in one write,
         so one read hands over both) and `announce-first`. */
      const said = {
        method: 'thread/settings/updated',
        params: { threadId: params.threadId, threadSettings: threadSettings() },
      }
      switch (process.env['FAKE_CODEX_SETTINGS_ORDER']) {
        case 'answer-first':
          send({ id, result: {} })
          setTimeout(() => send(said), 100)
          return
        case 'one-chunk':
          process.stdout.write(`${JSON.stringify({ id, result: {} })}\n${JSON.stringify(said)}\n`)
          return
        case 'announce-first':
          process.stdout.write(`${JSON.stringify(said)}\n${JSON.stringify({ id, result: {} })}\n`)
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
            // FAKE_CODEX_PLAN_EFFORT gives Plan an effort of its own other than the model's default.
            { name: 'Plan', mode: 'plan', model: null, reasoning_effort: process.env['FAKE_CODEX_PLAN_EFFORT'] ?? 'medium' },
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
      send({ id, result: { data: storedThreads(), nextCursor: null, backwardsCursor: null } })
      return

    case 'thread/search': {
      // The real app-server searches what it has stored, and answers with as
      // many threads as match. A fixture that answers exactly one row
      // whatever was asked cannot show a caller doing per-row work on the
      // page it got back (#274).
      const term = String(params?.searchTerm ?? '').toLowerCase()
      const hits = storedThreads().filter((entry) =>
        `${entry.id} ${entry.preview}`.toLowerCase().includes(term),
      )
      send({
        id,
        result: {
          data: hits.map((entry) => ({ thread: entry, snippet: term })),
          nextCursor: null,
          backwardsCursor: null,
        },
      })
      return
    }

    case 'thread/read': {
      if (deletedThreads.has(params?.threadId)) {
        send({ id, error: { code: -32600, message: `thread ${params.threadId} not found` } })
        return
      }
      // The thread that was asked for, as the app-server answers: a read and a
      // listing describe the same conversation, down to its stored preview.
      // A thread the listing does not hold is one this process started, or
      // one of the unlisted histories.
      const stored = storedThreads().find((entry) => entry.id === params.threadId) ?? thread({ id: params.threadId, sessionId: params.threadId })
      const history = historyOf(params.threadId)
      if (!params.includeTurns) {
        send({ id, result: { thread: { ...stored, turns: [] } } })
        return
      }
      if (!history.stored) {
        send({ id, error: unmaterialized(params.threadId, 'includeTurns') })
        return
      }
      if (history.mode === 'paginated') {
        if (!since(151)) {
          send({ id, error: { code: -32600, message: 'paginated threads do not support thread/read(includeTurns=true)' } })
          return
        }
        notify('deprecationNotice', { summary: DEPRECATED.read, details: null })
      }
      send({ id, result: { thread: { ...stored, turns: history.turns } } })
      return
    }

    case 'thread/turns/list': {
      // Either history lists its turns, newest first unless asked otherwise:
      // without items, with a summary of them — the ask and the last answer —
      // or with all of them.
      const history = historyOf(params.threadId)
      if (turnListingsFailed < Number(process.env['FAKE_CODEX_FAIL_TURNS_LISTS'] ?? 0)) {
        turnListingsFailed += 1
        send({ id, error: { code: -32603, message: 'failed to list thread history: database is locked' } })
        return
      }
      if (!history.stored) {
        send({ id, error: unmaterialized(params.threadId, 'thread/turns/list') })
        return
      }
      const view = params.itemsView ?? 'summary'
      const page = pageOf(history.turns, params, 'desc', 'turns')
      const shown = (turn) =>
        view === 'full'
          ? turn.items
          : view === 'summary'
            ? [turn.items.find((item) => item.type === 'userMessage'), turn.items.findLast((item) => item.type === 'agentMessage')].filter(Boolean)
            : []
      send({ id, result: { ...page, data: page.data.map((turn) => ({ ...turn, items: shown(turn), itemsView: view })) } })
      return
    }

    case 'thread/items/list': {
      // A paginated thread's items, oldest first unless asked otherwise, each
      // in an entry naming its turn (from 0.145.0). Only a paginated thread
      // with something stored has any to page.
      const history = historyOf(params.threadId)
      if (history.mode !== 'paginated' || !history.stored) {
        send({ id, error: { code: -32601, message: 'thread/items/list is not supported yet' } })
        return
      }
      if (!params.cursor && params.turnId == null) changeBetweenListings(params.threadId, history)
      const entries = history.turns
        .filter((turn) => params.turnId == null || turn.id === params.turnId)
        .flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item })))
      send({ id, result: pageOf(entries, params, 'asc', 'items') })
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
            ...(ADDITIONAL_MODEL
              ? [{
                  id: ADDITIONAL_MODEL,
                  model: ADDITIONAL_MODEL,
                  upgrade: null,
                  upgradeInfo: null,
                  availabilityNux: null,
                  displayName: process.env['FAKE_CODEX_ADDITIONAL_MODEL_NAME'] ?? ADDITIONAL_MODEL,
                  description: 'Profile model',
                  hidden: false,
                  supportedReasoningEfforts: [
                    { reasoningEffort: 'low', description: 'fast' },
                    { reasoningEffort: 'high', description: 'deep' },
                  ],
                  defaultReasoningEffort: 'medium',
                  inputModalities: ['text', 'image'],
                  supportsPersonality: true,
                  additionalSpeedTiers: [],
                  serviceTiers: [],
                  defaultServiceTier: null,
                  isDefault: false,
                }]
              : []),
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
      const response = { id, result: { turn: { id: TURN, items: [], itemsView: 'full', status: 'inProgress', error: null } } }
      const said = (params.input ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(' ')
        .trim()
      const background = /^(bg|failbg|endbg)\s+(.+)$/.exec(said)
      if (background) {
        send(response)
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
      // The person's words, without the context blocks the desk puts in front
      // of them, so a person typing `verify …` in the app reaches this too.
      const words = said.replace(/<context source=[^>]*>[\s\S]*?<\/context>/g, '').trim()
      const verify = /^verify\s+(.+)$/.exec(words)
      /* FAKE_CODEX_TURN_START_ORDER=one-chunk reproduces a real app-server
         stdout read that carries the turn/start answer, turn/started and both
         opening-item notifications together. The client's synchronous decode
         loop therefore sees every notification before an awaiting send() can
         resume on its promise microtask. */
      if (mode === 'turn' && !background && !verify && process.env['FAKE_CODEX_TURN_START_ORDER'] === 'one-chunk') {
        process.stdout.write(`${[response, ...turnOpening()].map((message) => JSON.stringify(message)).join('\n')}\n`)
        setImmediate(() => playTurn(true))
        return
      }
      send(response)
      if (verify) {
        setImmediate(() => askVerification(verify[1]))
        return
      }
      if (mode === 'turn') setImmediate(playTurn)
      if (mode === 'dynamic-tools') setImmediate(callDeclaredTool)
      if (mode === 'delegated-tools') setImmediate(callDeclaredToolAsChild)
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
      if (runningReviews.has(params.threadId)) {
        stopReview(id, params)
        return
      }
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

    case 'thread/delete':
      if (params?.threadId) deletedThreads.add(params.threadId)
      send({ id, result: {} })
      return

    case 'thread/name/set':
      send({ id, result: {} })
      notify('thread/name/updated', { threadId: params.threadId, threadName: params.name })
      return

    default:
      send({ id, result: {} })
  }
})

process.stdin.on('close', () => process.exit(0))

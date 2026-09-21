/**
 * The desk: a real HarnessDesk, launched with its debugger open and driven
 * through the very store the interface uses.
 *
 * Nothing here is a simulation of the product. The app is started the way a
 * person starts it — its own host, its own window — and every verb below is
 * one the interface itself calls: `openWorkspace`, `newSession`, `createRoom`,
 * `joinRoom`, `teamHandout`, `respondToApproval`. That is deliberate: a
 * review driven straight through the transport would create conversations the
 * host knows about and the sidebar does not, and the room left behind
 * afterwards is half the point of running the review here at all.
 */
import { spawn, execFile } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll the rendered fact, not an earlier store update; fail closed at the deadline. */
export const waitForSnapshot = async (read, matches, { attempts = 120, sleepImpl = sleep } = {}) => {
  let snapshot
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    snapshot = await read()
    if (matches(snapshot)) return snapshot
    if (attempt + 1 < attempts) await sleepImpl(100)
  }
  throw new Error(`snapshot did not converge: ${JSON.stringify(snapshot)}`)
}

/**
 * The separator inside a SessionKey: the runtime id, a NUL, the session id.
 *
 * Built rather than written as an escape, because a literal NUL in a source
 * file is invisible in every editor and diff that will ever show this line.
 */
export const SEP = String.fromCharCode(0)

export const splitKey = (key) => {
  const cut = String(key).indexOf(SEP)
  if (cut < 0) throw new Error(`"${key}" is not a SessionKey — it has no separator`)
  return { runtime: String(key).slice(0, cut), sessionId: String(key).slice(cut + 1) }
}

/** A minimal CDP client — Node has WebSocket, so nothing else is needed. */
export class Cdp {
  #ws
  #id = 0
  #waiting = new Map()
  /**
   * Subscribers for CDP *events* — messages with a method and no id.
   *
   * Every one of those was dropped on the floor until the screencast needed
   * them: a request/response client is all a review or a screenshot takes, and
   * a recording is the first caller that has to hear the page speak first.
   * Additive on purpose — nothing else subscribes, so nothing else changes.
   */
  #listeners = new Map()

  static async open(url) {
    const client = new Cdp()
    await client.#connect(url)
    return client
  }

  async #connect(url) {
    this.#ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      this.#ws.onopen = resolve
      this.#ws.onerror = reject
    })
    this.#ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id === undefined) {
        for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params)
        return
      }
      const seat = this.#waiting.get(message.id)
      this.#waiting.delete(message.id)
      if (!seat) return
      clearTimeout(seat.timer)
      if (message.error) seat.reject(new Error(String(message.error.message)))
      else seat.resolve(message.result)
    }
  }

  send(method, params = {}, timeout = 30_000) {
    const id = (this.#id += 1)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#waiting.delete(id)) reject(new Error(`${method} timed out after ${timeout}ms`))
      }, timeout)
      this.#waiting.set(id, { resolve, reject, timer })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /**
   * Evaluate in the renderer and hand back the value.
   *
   * `timeout` is generous where it is asked to be: starting a cold agent is a
   * process launch, an ACP handshake and a catalogue read, and thirty seconds
   * is not always enough for the first one of the day.
   */
  async eval(expression, timeout = 30_000) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      timeout,
    )
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate threw')
    }
    return result.result?.value
  }

  /**
   * The same, for an expression whose answer is worth parsing.
   *
   * The `await` inside is load-bearing. `JSON.stringify(store.modelsFor(id))`
   * stringifies the *promise* — `{}` — and `awaitPromise` never sees it,
   * because the expression it is handed already resolved to a string. Every
   * store verb that answers with a promise came back as an empty object until
   * this was an async IIFE.
   */
  async json(expression, timeout = 30_000) {
    const text = await this.eval(`(async () => JSON.stringify(await (${expression})))()`, timeout)
    return text === undefined ? undefined : JSON.parse(text)
  }

  /** Listen for one CDP event. Returns the function that stops listening. */
  on(method, listener) {
    this.#listeners.set(method, [...(this.#listeners.get(method) ?? []), listener])
    return () => this.#listeners.set(method, (this.#listeners.get(method) ?? []).filter((one) => one !== listener))
  }

  close() {
    try {
      this.#ws.close()
    } catch {
      /* already gone */
    }
  }
}

/**
 * Any HarnessDesk already running on this state directory.
 *
 * Two hosts on one `HARNESSDESK_HOME` is two writers on one set of rooms,
 * conversations and names: the last to write wins and the other's room
 * quietly disappears. macOS lets a process read its own user's environment,
 * so this is a question that can be answered rather than guessed at.
 */
export const deskInUse = async (home) => {
  const { stdout } = await run('/bin/ps', ['-Ao', 'pid=,command='], { maxBuffer: 1 << 24 })
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const [, pid, command] = match
    if (Number(pid) === process.pid) continue
    if (!/MacOS\/Electron|electron\/cli\.js/.test(command)) continue
    const env = await run('/bin/ps', ['eww', '-p', pid], { maxBuffer: 1 << 22 }).catch(() => null)
    if (!env) continue
    const found = / HARNESSDESK_HOME=(\S+)/.exec(env.stdout)
    if (found && found[1] === home) return Number(pid)
  }
  return null
}

/**
 * Pick the first-party renderer and never a webview or auxiliary window.
 * During a cold launch Chromium may expose the renderer before its document
 * has set the title; the token-gated host URL is the stable identity then.
 */
export const selectMainPage = (targets) =>
  targets.find((target) => target.type === 'page' && target.title === 'HarnessDesk')
  ?? targets.find((target) =>
    target.type === 'page'
    && /^https?:\/\/127\.0\.0\.1:\d+\/\?(?:[^#]*&)?token=/.test(target.url),
  )

/**
 * Launch the app with the debugger open, and hand back the renderer's socket.
 *
 * The user-data directory is ours, never the default one: Electron keys its
 * single-instance lock on that directory, so sharing it with an app the person
 * already has open would make this launch quit silently — and steal the focus
 * of their window on the way out.
 */
export const launchDesk = async ({ app, home, port = 0, userDataDir, logPath, executable, env = process.env }) => {
  const electron = executable ?? `${app}/packages/desktop/node_modules/.bin/electron`
  if (!existsSync(electron)) {
    throw new Error(`no electron at ${electron} — run pnpm install in ${app}`)
  }
  if (!existsSync(`${app}/packages/ui/dist/index.html`)) {
    throw new Error(`${app}/packages/ui/dist is not built — run pnpm build in ${app}`)
  }
  const child = spawn(
    electron,
    // Like smoke-packaged.mjs, a disposable profile must not prompt for or
    // read the developer's login Keychain after each ad-hoc-signed rebuild.
    [...(executable ? ['--use-mock-keychain'] : ['.']), `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`],
    {
      cwd: `${app}/packages/desktop`,
      env: {
        ...env,
        HARNESSDESK_HOME: home,
        HARNESSDESK_LOG_LEVEL: env.HARNESSDESK_LOG_LEVEL ?? 'error',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const sink = logPath ? createWriteStream(logPath, { flags: 'a' }) : null
  child.stdout.on('data', (chunk) => sink?.write(chunk))
  child.stderr.on('data', (chunk) => sink?.write(chunk))

  let browserUrl
  try {
    browserUrl = await waitForDebugger(child)
  } catch (error) {
    await closeDesk({ child, sink })
    throw error
  }
  const ownedPort = Number(new URL(browserUrl).port)
  return connectDesk({ child, sink, port: ownedPort, browserUrl, ...(executable ? { discoveryAttempts: 300 } : {}) })
}

/** Read the endpoint from this child's stderr, never from a guessed port. */
export const waitForDebugger = (child, timeoutMs = 30_000) => new Promise((resolve, reject) => {
  let output = ''
  const finish = (error, endpoint) => {
    clearTimeout(timer)
    child.stderr.off('data', onData)
    child.off('exit', onExit)
    child.off('error', onError)
    if (error) reject(error)
    else resolve(endpoint)
  }
  const onData = chunk => {
    output = (output + chunk.toString()).slice(-8192)
    const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)\s/.exec(output)
    if (match) finish(null, match[1])
  }
  const onExit = () => finish(new Error('Electron exited before announcing its debugger'))
  const onError = error => finish(error)
  const timer = setTimeout(() => finish(new Error('Electron did not announce its own debugger')), timeoutMs)
  child.stderr.on('data', onData)
  child.once('exit', onExit)
  child.once('error', onError)
})

/**
 * Finish a spawned launch. Kept separate so the failure path can be exercised
 * without starting Electron: once a process exists, every later error must
 * close CDP, stop the process, await its exit, and finish the log stream.
 */
export const connectDesk = async ({
  child,
  sink = null,
  port,
  browserUrl,
  fetchImpl = fetch,
  openCdp = Cdp.open,
  sleepImpl = sleep,
  discoveryAttempts = 90,
  storeAttempts = 60,
}) => {
  let cdp
  try {
    if (!browserUrl) throw new Error('debugger ownership requires the spawned child endpoint')
    for (let attempt = 0; attempt < discoveryAttempts; attempt += 1) {
      await sleepImpl(1000)
      let page
      let list, version
      try {
        version = await (await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })).json()
        list = await (await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json()
      } catch {
        continue /* the debugger is not up yet */
      }
      if (version.webSocketDebuggerUrl !== browserUrl) throw new Error('debugger ownership mismatch: refusing a foreign process')
      // Auxiliary windows (the native About panel) are pages too. Prefer the
      // exact main-window title so a verification run that deliberately opens
      // one does not wait for an app store that auxiliary HTML does not own.
      page = selectMainPage(list)
      if (!page?.webSocketDebuggerUrl) continue
      // A non-HarnessDesk debugger target is ignored by selectMainPage; only a
      // target with the app's exact title or token-gated renderer URL arrives.
      cdp = await openCdp(page.webSocketDebuggerUrl)
      // The store is what everything below talks to; a renderer that has not
      // finished booting has none yet.
      for (let ready = 0; ready < storeAttempts; ready += 1) {
        if (await cdp.eval('Boolean(window.__hdStore)').catch(() => false)) return { child, cdp, sink, port, browserUrl }
        await sleepImpl(1000)
      }
      throw new Error('the renderer came up without a store')
    }
    throw new Error(`no renderer appeared on port ${port} in ${discoveryAttempts}s`)
  } catch (error) {
    await closeDesk({ child, cdp, sink })
    throw error
  }
}

export const closeDesk = async ({ child, cdp, sink }) => {
  try {
    cdp?.close()
  } catch {
    /* already gone */
  }
  if (child && child.exitCode === null && child.signalCode === null) {

  /** Wait for the process, not just the grace period. Electron can still be
   * writing its profile between `kill` and the `exit` event; deleting the
   * isolated home in that interval races those final writes. */
  const waitForExit = (timeout) => new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.off('exit', done)
      resolve(false)
    }, timeout)
    child.once('exit', done)
  })

    child.kill('SIGTERM')
    if (!(await waitForExit(2500))) {
      child.kill('SIGKILL')
      await waitForExit(2500)
    }
  }
  if (sink && !sink.writableEnded) {
    await new Promise((resolve) => sink.end(resolve))
  }
}

/** `window.__hdStore`, spelled once. */
export const STORE = 'window.__hdStore'
const q = (value) => JSON.stringify(value)

export const openWorkspace = async (cdp, path) => {
  await cdp.eval(`${STORE}.openWorkspace(${q(path)})`, 120_000)
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await cdp.eval(`${STORE}.getSnapshot().workspace?.path === ${q(path)}`)) return true
    await sleep(1000)
  }
  throw new Error(`the workspace never opened on ${path}`)
}

/**
 * Every runtime the desk has, with the version of the software behind it.
 *
 * `drives` is the agent CLI a bridge drives and `version` is the bridge's
 * own — for Claude Code those are two different numbers, and the one that
 * belongs in a signed review is the agent's.
 */
export const runtimes = async (cdp) =>
  cdp.json(`${STORE}.getSnapshot().runtimes.map((r) => ({
    id: r.id, name: r.name, version: r.version ?? null,
    drives: r.drives ? { command: r.drives.command, version: r.drives.version ?? null } : null,
  }))`)

export const modelsFor = async (cdp, runtime) => cdp.json(`${STORE}.modelsFor(${q(runtime)})`, 60_000)

/**
 * Start one member: the picks first, then the conversation.
 *
 * The picks go through `setNewSessionDefault`, which is the composer's own
 * path — and which *drops* a pick the runtime refuses rather than failing, so
 * what was actually kept has to be read back from the session afterwards and
 * compared. A review that believes it ran at maximum effort because it asked
 * for maximum effort is a review with an unchecked claim at the top of it.
 */
export const seat = async (cdp, { work, runtime, picks }) => {
  for (const [id, value] of Object.entries(picks)) {
    await cdp.eval(`${STORE}.setNewSessionDefault(${q(runtime)}, ${q(id)}, ${q(value)})`, 120_000)
  }
  const key = await cdp.eval(`${STORE}.newSession(${q({ cwd: work, runtime })})`, 180_000)
  if (!key) throw new Error(`${runtime} would not start a session — is it signed in?`)
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await cdp.eval(`${STORE}.getSnapshot().sessions.has(${q(key)})`)) break
    await sleep(2000)
  }
  return key
}

/**
 * A live conversation's own controls, whole — values and the runtime's labels
 * for them.
 *
 * This is the authority, not the catalogue. A model's effort levels are
 * declared per session by some bridges, so a desk that has never run one
 * answers the catalogue question with silence: on a cold desk Claude Code's
 * model list carries no levels at all, and a cast checked only against that
 * list is refused for asking a model to think.
 */
export const optionsOf = async (cdp, key) =>
  cdp.json(`(() => {
    const session = ${STORE}.getSnapshot().sessions.get(${q(key)})
    if (!session) return null
    return (session.options ?? []).map((option) => ({
      id: option.id,
      label: option.label ?? option.name ?? option.id,
      currentValue: option.currentValue ?? null,
      choices: (option.choices ?? option.options ?? []).map((choice) => ({
        value: choice.value,
        label: choice.label ?? choice.name ?? String(choice.value),
      })),
    }))
  })()`)

/** Sets one control on a live conversation — the composer's own verb. */
export const setSessionOption = async (cdp, key, id, value) =>
  cdp.eval(`${STORE}.setOption(${q(id)}, ${q(value)}, ${q(key)})`, 60_000)

export const makeRoom = async (cdp, { work, name, members }) => {
  const joins = members
    .map(({ runtime, sessionId }, index) => `{
      const card = await store.transport.request('team/add', { room, title: ${q(`Seat ${index + 1}`)} })
      await store.assignGoal(room, card.id, { runtime: ${q(runtime)}, sessionId: ${q(sessionId)} })
    }`)
    .join('\n    ')
  const room = await cdp.eval(
    `(async () => {
    const store = ${STORE}
    const room = (await store.createGoal({ root: ${q(work)}, sentence: ${q(name)} })).goal.id
    ${joins}
    return room
  })()`,
    180_000,
  )
  if (!room) throw new Error(`the Goal "${name}" was not created`)
  return room
}

/** The room, whole, as the board holds it. */
export const board = async (cdp, room) =>
  cdp.json(`${STORE}.getSnapshot().teams.get(${q(room)}) ?? null`, 60_000)

/**
 * One message to many members, each with its own values, as one action.
 *
 * A hand-out rather than a post, because each reviewer signs with its own name
 * and version: posting one text to the room would hand every agent all three
 * signatures and leave the choosing to it, which is exactly the kind of
 * instruction a model gets subtly wrong at the end of a long turn.
 */
export const handout = async (cdp, room, template, recipients) =>
  cdp.json(`${STORE}.teamHandout(${q(room)}, ${q(template)}, ${q(recipients)})`, 180_000)

/**
 * Answer every pending approval with the agent's own "allow".
 *
 * Claude Code asks before each shell command and a review runs `gh` a dozen
 * times; an unanswered ask reads exactly like a hung tool, and three takes
 * were once lost to that diagnosis. The decision shape matters:
 * `{ type: 'option', optionId }` is the only one the host accepts —
 * `{ type: 'approve' }` is silently rejected and the same request comes back
 * forever. `approveAlways` where the runtime offers it, or one command
 * re-asks a dozen times.
 *
 * Questions are never answered here. A `userInput` or `elicitation` approval
 * is a model asking a person something, and answering on their behalf is how
 * a review ends up agreeing to a question nobody read.
 */
export const answerApprovals = async (cdp) => {
  const pending = await cdp.json(`${STORE}.getSnapshot().approvals.map((entry) => ({
    key: entry.key,
    id: entry.approval.id,
    type: entry.approval.type,
    what: entry.approval.command ?? entry.approval.summary ?? entry.approval.tool ?? null,
    option: (entry.approval.options ?? []).find((o) => o.intent === 'approveAlways')?.id
      ?? (entry.approval.options ?? []).find((o) => o.intent === 'approve')?.id ?? null,
  }))`)
  const answered = []
  const asking = []
  for (const one of pending ?? []) {
    if (!one.option) {
      asking.push(one)
      continue
    }
    await cdp.eval(
      `${STORE}.respondToApproval(${q(one.key)}, ${q(one.id)}, { type: 'option', optionId: ${q(one.option)} })`,
      60_000,
    )
    answered.push(one)
  }
  return { answered, asking }
}

/** Puts the room on screen, so a person watching the window sees the work. */
export const showRoom = async (cdp, room) => {
  await cdp.eval(`${STORE}.openTeamRoom(${q(room)})`).catch(() => null)
}

export const dismissNotices = async (cdp) => {
  await cdp
    .eval(
      `(() => { const s = ${STORE}; for (const n of s.getSnapshot().notices ?? []) s.dismissNotice(n.id); return true })()`,
    )
    .catch(() => null)
}

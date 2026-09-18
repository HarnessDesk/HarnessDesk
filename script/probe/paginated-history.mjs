import { execFileSync, spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/**
 * How a conversation's history is read, forked and undone against a real
 * `codex app-server`, the way the Codex adapter does each — and whether Codex
 * says anything about it. No credits, account or network: the model is a fake
 * Responses endpoint served here.
 *
 *   node script/probe/paginated-history.mjs [--codex <path to codex>] [--history paginated|legacy] [--keep]
 *
 * `--history` starts the first thread with that history mode rather than the
 * release's own: `paginated` on 0.145.0 is a conversation a newer Codex
 * started, opened after a downgrade.
 *
 * Why it exists: since 0.151.0 Codex keeps a new thread's history in pages
 * (`historyMode: "paginated"`), and answers a whole-history read of one —
 * `thread/read` with `includeTurns`, `thread/fork` or `thread/resume` without
 * `excludeTurns` — with a `deprecationNotice`, which the desk showed as a toast
 * naming wire methods. It also refuses `thread/rollback` on such a thread,
 * after a notice of its own. A thread an older Codex started ("legacy") is the
 * other way round. So every check here is a call the adapter makes for one kind
 * of thread or the other, and running it on the oldest supported Codex
 * (`MINIMUM_CODEX_VERSION`, 0.145.0) and the newest says whether both take
 * the route.
 *
 * Each "no notice" check has a control: the deprecated call on the same thread,
 * which must be the one that draws the notice. Without it, "no notice" could
 * mean a probe that cannot hear notices at all.
 */

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const CODEX = arg('codex', 'codex')
const HISTORY = arg('history', null)
const KEEP = process.argv.includes('--keep')

const version = execFileSync(CODEX, ['--version'], { encoding: 'utf8' }).trim()
const [major, minor] = (/(\d+)\.(\d+)\.\d+/.exec(version) ?? [0, 0, 0]).slice(1).map(Number)
const since = (m) => major > 0 || minor >= m

// ------------------------------------------------------------ fake model

let replies = 0
const gateway = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    if (req.method !== 'POST') {
      res.writeHead(404).end()
      return
    }
    replies += 1
    const text = `REPLY-${replies}`
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const base = { id: `resp_${replies}`, object: 'response', created_at: Math.floor(Date.now() / 1e3), model: 'probe-model', status: 'in_progress', output: [] }
    const item = { id: `msg_${replies}`, type: 'message', status: 'in_progress', role: 'assistant', content: [] }
    const done = { ...item, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    send('response.created', { type: 'response.created', response: base, sequence_number: 0 })
    send('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item, sequence_number: 1 })
    send('response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text, sequence_number: 2 })
    send('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: done, sequence_number: 3 })
    send('response.completed', {
      type: 'response.completed',
      sequence_number: 4,
      response: { ...base, status: 'completed', output: [done], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 13 } },
    })
    res.end()
  })
})
await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
const port = gateway.address().port

// ------------------------------------------------------------- the stage

const root = mkdtempSync(join(tmpdir(), 'hd-history-probe-'))
const home = join(root, 'home')
const repo = join(root, 'repo')
execFileSync('mkdir', ['-p', home, repo])
writeFileSync(
  join(home, 'config.toml'),
  [
    'model = "probe-model"',
    'model_provider = "probe"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    '',
    '[model_providers.probe]',
    'name = "Probe"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'env_key = "PROBE_API_KEY"',
    'wire_api = "responses"',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
  ].join('\n'),
)

// ------------------------------------------------------------ the client

/** One `codex app-server`, spoken to as the adapter speaks to it. */
const connect = async () => {
  const child = spawn(CODEX, ['app-server'], {
    env: { ...process.env, CODEX_HOME: home, PROBE_API_KEY: 'probe-key' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.on('data', () => {})
  let nextId = 0
  const pending = new Map()
  const heard = []
  const waiters = new Set()
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.id !== undefined && message.method === undefined) {
      const call = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) call?.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
      else call?.resolve(message.result)
      return
    }
    if (message.id !== undefined) {
      child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'probe' } })}\n`)
      return
    }
    heard.push(message)
    for (const waiter of [...waiters]) waiter()
  })
  const request = (method, params) => {
    const id = ++nextId
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }
  const until = (predicate, ms = 30_000) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const found = heard.find(predicate)
        if (!found) return
        waiters.delete(check)
        clearTimeout(timer)
        resolve(found)
      }
      const timer = setTimeout(() => {
        waiters.delete(check)
        reject(new Error('timed out'))
      }, ms)
      waiters.add(check)
      check()
    })
  // The adapter's handshake: its client name, which is not `codex-tui` — the
  // one client Codex spares its rollback notice — and the experimental API.
  await request('initialize', {
    clientInfo: { name: 'harnessdesk', title: 'HarnessDesk', version: '0.0.1' },
    capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] },
  })
  child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
  const close = async () => {
    child.stdin.end()
    await new Promise((resolve) => child.once('exit', resolve))
  }
  return { request, until, heard, close }
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const info = (text) => console.log(`info  ${text}`)
const refusal = (promise) => promise.then(() => null, (error) => error.message)

/** What Codex said while `run` ran: its answer, and the deprecation notices. */
const hearing = async (codex, run) => {
  const mark = codex.heard.length
  let answer = null
  let refused = null
  try {
    answer = await run()
  } catch (error) {
    refused = error.message
  }
  // Codex writes a notice before its answer; a moment covers one sent after.
  await new Promise((resolve) => setTimeout(resolve, 200))
  const notices = codex.heard.slice(mark).filter((m) => m.method === 'deprecationNotice').map((m) => m.params.summary)
  return { answer, refused, notices }
}

const say = async (codex, threadId, text) => {
  const mark = codex.heard.length
  await codex.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] })
  await codex.until((m) => m.method === 'turn/completed' && m.params.threadId === threadId && codex.heard.indexOf(m) >= mark)
}

/** Every page of a listing, as the adapter reads one: `nextCursor` until there is none. */
const everyPage = async (fetch) => {
  const all = []
  let cursor = null
  do {
    const page = await fetch(cursor)
    all.push(...page.data)
    cursor = page.nextCursor
  } while (cursor)
  return all
}

/**
 * A thread's turns, each with its items, read the adapter's way: a paginated
 * thread in pages (small ones, so the cursors are followed), anything else
 * whole. Pages of two, so three turns of two items each take several.
 */
const history = async (codex, thread) => {
  if (thread.historyMode !== 'paginated') {
    return (await codex.request('thread/read', { threadId: thread.id, includeTurns: true })).thread.turns
  }
  const turns = await everyPage((cursor) =>
    codex.request('thread/turns/list', { threadId: thread.id, cursor, limit: 2, sortDirection: 'asc', itemsView: 'notLoaded' }),
  )
  const items = await everyPage((cursor) =>
    codex.request('thread/items/list', { threadId: thread.id, cursor, limit: 2, sortDirection: 'asc' }),
  )
  return turns.map((turn) => ({ ...turn, items: items.filter((entry) => entry.turnId === turn.id).map((entry) => entry.item) }))
}

/** Turn and item ids, the shape two reads are compared by. */
const shape = (turns) => turns.map((turn) => `${turn.id}[${turn.items.map((item) => `${item.type}:${item.id}`).join(',')}]`).join(' ')

/** The adapter's undo: `thread/revert` before the `n`th turn from the end on a paginated thread, `thread/rollback` otherwise. */
const undo = async (codex, thread, n) => {
  if (thread.historyMode !== 'paginated') return codex.request('thread/rollback', { threadId: thread.id, numTurns: n })
  const newest = await codex.request('thread/turns/list', { threadId: thread.id, limit: n, sortDirection: 'desc', itemsView: 'notLoaded' })
  return codex.request('thread/revert', { threadId: thread.id, beforeTurnId: newest.data.at(-1).id })
}

console.log(`${version}\n`)
let codex = await connect()
try {
  // ---------------------------------------------- a thread this Codex starts
  const started = await codex.request('thread/start', { cwd: repo, ...(HISTORY ? { historyMode: HISTORY } : {}) })
  const thread = started.thread
  const paginated = thread.historyMode === 'paginated'
  check(
    HISTORY ? `a thread asked for ${HISTORY} history keeps it` : 'a new thread is paginated from 0.151.0, legacy before',
    paginated === (HISTORY ? HISTORY === 'paginated' : since(151)),
    `historyMode ${JSON.stringify(thread.historyMode)}`,
  )
  for (const word of ['one', 'two', 'three']) await say(codex, thread.id, word)

  const head = await hearing(codex, () => codex.request('thread/read', { threadId: thread.id }))
  check('thread/read without turns draws no notice', head.notices.length === 0 && head.refused === null, head.refused ?? head.notices.join(' | '))
  check('it says how the thread keeps its history', head.answer?.thread.historyMode === thread.historyMode)

  const read = await hearing(codex, () => history(codex, thread))
  check(
    `the history, read ${paginated ? 'in pages' : 'whole'}, draws no notice`,
    read.notices.length === 0 && read.refused === null,
    read.refused ?? read.notices.join(' | '),
  )
  check(
    'it holds every turn, each with its own items',
    read.answer?.length === 3 && read.answer.every((turn) => turn.items.some((item) => item.type === 'userMessage') && turn.items.some((item) => item.type === 'agentMessage')),
    read.answer ? `${read.answer.length} turns, ${read.answer.map((turn) => turn.items.length).join('+')} items` : '',
  )
  if (paginated) {
    const whole = await hearing(codex, () => codex.request('thread/read', { threadId: thread.id, includeTurns: true }))
    if (since(151)) {
      check('control: a whole read of a paginated thread draws a notice', whole.notices.length === 1, whole.notices[0] ?? 'none')
      check('and the pages hold what the whole read held', shape(read.answer ?? []) === shape(whole.answer?.thread.turns ?? []))
    } else {
      info(`a whole read of a paginated thread — ${whole.refused ?? 'answered'}`)
    }
    const items = await refusal(codex.request('thread/items/list', { threadId: thread.id, limit: 1 }))
    check('thread/items/list pages a paginated thread', items === null, items ?? '')
  }

  // Forking: the adapter asks for the fork without its turns, then reads them.
  const fork = await hearing(codex, () => codex.request('thread/fork', { threadId: thread.id, excludeTurns: true }))
  if (fork.refused) {
    info(`thread/fork of this thread — refused: ${fork.refused}`)
  } else {
    check('thread/fork with excludeTurns draws no notice', fork.notices.length === 0, fork.notices.join(' | '))
    const forked = fork.answer.thread
    check('the fork keeps history the way its source does', forked.historyMode === thread.historyMode, forked.historyMode)
    const forkRead = await hearing(codex, () => history(codex, forked))
    check('and its history reads the same way, silently', forkRead.notices.length === 0 && (forkRead.answer?.length ?? 0) === 3, forkRead.refused ?? `${forkRead.answer?.length} turns`)
    const withTurns = await hearing(codex, () => codex.request('thread/fork', { threadId: thread.id }))
    if (paginated && since(151)) {
      check('control: a fork with its turns included draws a notice', withTurns.notices.length === 1, withTurns.notices[0] ?? 'none')
    } else {
      info(`a fork with its turns included — ${withTurns.notices.length} notice(s)`)
    }
  }

  // Undo, the adapter's way, then once more the deprecated way as the control.
  const undone = await hearing(codex, () => undo(codex, thread, 1))
  if (paginated && !since(148)) {
    check('thread/revert is unknown before 0.148.0', /unknown variant `thread\/revert`/.test(undone.refused ?? ''), (undone.refused ?? 'accepted').slice(0, 80))
  } else {
    check(
      `undo by ${paginated ? 'thread/revert' : 'thread/rollback'} is taken`,
      undone.refused === null,
      undone.refused ?? '',
    )
    if (paginated) {
      check('thread/revert draws no notice', undone.notices.length === 0, undone.notices.join(' | '))
      const reverted = await codex.until((m) => m.method === 'thread/reverted' && m.params.threadId === thread.id, 5_000).catch(() => null)
      check('and Codex says the thread was reverted', reverted !== null)
    } else {
      info(`thread/rollback on a legacy thread — notice: ${undone.notices[0] ?? 'none'}`)
    }
    const after = await history(codex, thread)
    check('the last turn is gone, the rest are as they were', after.length === 2 && shape(after) === shape((read.answer ?? []).slice(0, 2)), `${after.length} turns`)
    const twice = await hearing(codex, () => undo(codex, thread, 2))
    const emptied = await history(codex, thread)
    check('undoing more turns than one drops each of them', twice.refused === null && emptied.length === 0, twice.refused ?? `${emptied.length} turns left`)
    await say(codex, thread.id, 'four')
    const again = await history(codex, thread)
    check('the thread takes a turn after being undone', again.length === 1, `${again.length} turn(s)`)
  }
  if (paginated) {
    const rolled = await hearing(codex, () => codex.request('thread/rollback', { threadId: thread.id, numTurns: 1 }))
    check(
      'control: thread/rollback on a paginated thread is refused, after a notice',
      /paginated threads do not support thread\/rollback/.test(rolled.refused ?? '') && rolled.notices.length === 1,
      `${rolled.refused ?? 'accepted'}; notice: ${rolled.notices[0] ?? 'none'}`,
    )
  }

  // A thread with no first message has nothing stored, and says so in words
  // the adapter reads as "no turns" — or, held live, in words it leaves to the
  // host's own transcript.
  const fresh = (await codex.request('thread/start', { cwd: repo })).thread
  const none = await refusal(history(codex, fresh))
  info(`a thread with no first message, read — ${none ?? 'answered'}`)

  // --------------------------------------------- a legacy thread on this Codex
  // What a thread an older Codex started is to this one. Before 0.151.0 that is
  // every thread; after, `historyMode: "legacy"` asks for one.
  let legacy = null
  try {
    legacy = (await codex.request('thread/start', { cwd: repo, ...(since(151) ? { historyMode: 'legacy' } : {}) })).thread
  } catch (error) {
    info(`thread/start with historyMode legacy — refused: ${error.message}`)
  }
  if (legacy) {
    check('a legacy thread says so', legacy.historyMode === 'legacy', legacy.historyMode)
    for (const word of ['one', 'two']) await say(codex, legacy.id, word)
    const whole = await hearing(codex, () => history(codex, legacy))
    check('a legacy thread is read whole, with no notice', whole.notices.length === 0 && whole.answer?.length === 2, whole.refused ?? whole.notices.join(' | '))
    const items = await refusal(codex.request('thread/items/list', { threadId: legacy.id, limit: 1 }))
    check('thread/items/list refuses a legacy thread', items !== null, items ?? 'answered')
    if (since(148)) {
      const revert = await refusal(codex.request('thread/revert', { threadId: legacy.id, beforeTurnId: whole.answer[1].id }))
      check('thread/revert refuses a legacy thread', revert !== null, revert ?? 'accepted')
    }
    const rolled = await hearing(codex, () => undo(codex, legacy, 1))
    check('thread/rollback undoes a legacy thread', rolled.refused === null && (await history(codex, legacy)).length === 1, rolled.refused ?? '')
    info(`Codex's notice for it, which it has no replacement for — ${rolled.notices[0] ?? 'none'}`)
  }

  // ------------------------------------------- the thread, opened cold
  // Another app-server on the same home, as the desk is after a restart: the
  // conversation read as opening it from the list reads it, then resumed the
  // adapter's way, without its turns.
  const kept = shape(await history(codex, thread))
  await codex.close()
  codex = await connect()
  const cold = await hearing(codex, async () => history(codex, (await codex.request('thread/read', { threadId: thread.id })).thread))
  check(
    'opened cold, it reads the same, with no notice',
    cold.notices.length === 0 && cold.refused === null && shape(cold.answer ?? []) === kept,
    cold.refused ?? `${cold.answer?.length} turn(s)`,
  )
  const resumed = await hearing(codex, () => codex.request('thread/resume', { threadId: thread.id, excludeTurns: true }))
  check('thread/resume with excludeTurns draws no notice', resumed.notices.length === 0 && resumed.refused === null, resumed.refused ?? resumed.notices.join(' | '))
  const again = await hearing(codex, () => codex.request('thread/resume', { threadId: thread.id }))
  if (paginated && since(151)) {
    check('control: a resume with its turns included draws a notice', again.notices.length === 1, again.notices[0] ?? 'none')
  } else {
    info(`a resume with its turns included — ${again.notices.length} notice(s)`)
  }
} finally {
  await codex.close().catch(() => {})
  gateway.close()
  if (!KEEP) rmSync(root, { recursive: true, force: true })
  else console.log(`\nkept ${root}`)
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)

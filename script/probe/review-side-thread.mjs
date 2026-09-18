import { execFileSync, spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/**
 * A review on a side thread without `delivery: "detached"`, against a real
 * `codex app-server`: `thread/start` with the reviewed conversation's settings,
 * then `review/start` with `delivery: "inline"` on the new thread. No credits,
 * account or network — the model is a fake Responses endpoint served here.
 *
 *   node script/probe/review-side-thread.mjs [--codex <path to codex>] [--keep] [--shapes]
 *
 * Why it exists: Codex 0.155.0 deprecates detached review and sends a
 * `deprecationNotice` for every one, while HarnessDesk still runs on Codex
 * 0.145.0 (MINIMUM_CODEX_VERSION). Each check below is a call the adapter
 * makes, or something it relies on — the review turn's ids, and which turn a
 * stop has to name — so running this once per version answers "does this
 * Codex take the route?" from the binary rather than from its changelog.
 * `--shapes` prints the review's notifications whole, for the fixture.
 *
 * The last lines are the control: a detached review on the same app-server,
 * which on 0.155.0 must produce the deprecation notice the other checks are
 * asserting is absent. Without it, "no notice" could mean a probe that cannot
 * see notices at all.
 */

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const CODEX = arg('codex', 'codex')
const KEEP = process.argv.includes('--keep')
/** Prints the review turn's notifications whole — the shapes a fixture copies. */
const SHAPES = process.argv.includes('--shapes')

const version = execFileSync(CODEX, ['--version'], { encoding: 'utf8' }).trim()

// ------------------------------------------------------------ fake model

/** The JSON Codex's review rubric asks the reviewer to answer with. */
const REVIEW = {
  findings: [
    {
      title: '[P2] Greeting lost its punctuation',
      body: 'The edit drops the full stop the other lines keep.',
      confidence_score: 0.6,
      priority: 2,
      code_location: { absolute_file_path: 'README.md', line_range: { start: 1, end: 1 } },
    },
  ],
  overall_correctness: 'patch is correct',
  overall_explanation: 'One cosmetic finding.',
  overall_confidence_score: 0.7,
}

const requests = []
/** How long the reviewer is kept waiting for its answer — long enough to be stopped, when set. */
let holdReviewMs = 0
const gateway = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', async () => {
    if (req.method !== 'POST') {
      res.writeHead(404).end()
      return
    }
    if (holdReviewMs > 0 && body.includes('# Review guidelines:')) {
      await new Promise((resolve) => setTimeout(resolve, holdReviewMs))
      if (res.destroyed) return
    }
    // The review sub-agent runs on Codex's review rubric; anything else is an
    // ordinary turn, which the detached control's sub-agent is.
    const reviewing = body.includes('# Review guidelines:')
    requests.push(reviewing ? 'review' : 'turn')
    const text = reviewing ? JSON.stringify(REVIEW) : 'PROBE-OK'
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const base = { id: 'resp_probe', object: 'response', created_at: Math.floor(Date.now() / 1e3), model: 'probe-model', status: 'in_progress', output: [] }
    const item = { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] }
    const done = { ...item, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    send('response.created', { type: 'response.created', response: base, sequence_number: 0 })
    send('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item, sequence_number: 1 })
    send('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text, sequence_number: 2 })
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

const root = mkdtempSync(join(tmpdir(), 'hd-review-probe-'))
const home = join(root, 'home')
const repo = join(root, 'repo')
execFileSync('mkdir', ['-p', home, repo])
writeFileSync(
  join(home, 'config.toml'),
  [
    'model = "probe-model"',
    'model_provider = "probe"',
    'approval_policy = "never"',
    // A sandbox the configuration sets, with more than the profile named
    // after it gives: check 7 is whether a side thread keeps it.
    'sandbox_mode = "workspace-write"',
    '',
    '[sandbox_workspace_write]',
    'network_access = true',
    `writable_roots = [${JSON.stringify(join(root, 'extra'))}]`,
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
// A repository with something uncommitted, which is what the menu reviews.
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
git('init', '-q')
git('-c', 'user.email=probe@example.com', '-c', 'user.name=Probe', 'commit', '-q', '--allow-empty', '-m', 'root')
writeFileSync(join(repo, 'README.md'), 'Hello\n')

// ------------------------------------------------------------ the client

const child = spawn(CODEX, ['app-server'], {
  env: { ...process.env, CODEX_HOME: home, PROBE_API_KEY: 'probe-key' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stderr.on('data', () => {})
let nextId = 0
const pending = new Map()
/** Every notification, in arrival order, with its params. */
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
    // A server request (an approval): refused, so nothing waits on this probe.
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
const until = (predicate, ms = 60_000) =>
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
const since = (mark) => heard.slice(mark)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

console.log(`${version}\n`)
try {
  await request('initialize', {
    clientInfo: { name: 'harnessdesk-probe', title: 'HarnessDesk probe', version: '0.0.1' },
    capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] },
  })
  child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)

  // The conversation being reviewed, started the way the adapter starts one.
  const parent = await request('thread/start', { cwd: repo, permissions: ':read-only' })
  const parentId = parent.thread.id

  // 1. The side thread, on the parent's settings as `thread/start` reported them.
  const side = await request('thread/start', {
    cwd: parent.cwd,
    runtimeWorkspaceRoots: parent.runtimeWorkspaceRoots,
    model: parent.model,
    modelProvider: parent.modelProvider,
    serviceTier: parent.serviceTier,
    approvalPolicy: parent.approvalPolicy,
    approvalsReviewer: parent.approvalsReviewer,
    permissions: parent.activePermissionProfile?.id ?? ':read-only',
  })
  const sideId = side.thread.id
  check(
    'thread/start takes the parent settings',
    sideId !== parentId && side.cwd === parent.cwd && side.model === parent.model &&
      side.activePermissionProfile?.id === parent.activePermissionProfile?.id,
    `cwd, model ${side.model}, profile ${side.activePermissionProfile?.id ?? 'none'}`,
  )

  // 2. The effort, which thread/start does not take, goes as a settings update.
  let mark = heard.length
  await request('thread/settings/update', { threadId: sideId, effort: 'low' })
  const settled = await until(
    (m) => m.method === 'thread/settings/updated' && m.params.threadId === sideId,
    10_000,
  ).catch(() => null)
  check('thread/settings/update carries the effort', settled?.params.threadSettings.effort === 'low')

  // 3. The review, inline on the side thread, and its name while it runs:
  //    the adapter's order, which names nothing until Codex has taken the review.
  mark = heard.length
  const started = await request('review/start', {
    threadId: sideId,
    target: { type: 'uncommittedChanges' },
    delivery: 'inline',
  })
  check('review/start inline runs on the thread it names', started.reviewThreadId === sideId, `turn ${started.turn.id}`)
  await request('thread/name/set', { threadId: sideId, name: 'Review of uncommitted changes' })
  const ended = await until((m) => m.method === 'turn/completed' && m.params.threadId === sideId).catch(() => null)
  const review = since(mark)
  // What `ReviewTurns` (packages/adapter-codex) relies on. The review's items
  // and its completion carry the turn review/start answered with; Codex never
  // announces that turn, and the one `turn/started` it sends is the reviewer
  // sub-agent's, under another id, after the review's first item.
  const turnIds = new Set(
    review.flatMap((m) =>
      m.params?.threadId === sideId && (m.method.startsWith('item/') || m.method === 'turn/completed')
        ? [m.params.turnId ?? m.params.turn?.id]
        : [],
    ),
  )
  check('its items and completion name the turn review/start answered with', turnIds.size === 1 && turnIds.has(started.turn.id))
  const announced = review.filter((m) => m.method === 'turn/started' && m.params.threadId === sideId)
  const reviewer = announced.filter((m) => m.params.turn.id !== started.turn.id)
  console.log(
    `info  turn/started for the review's turn — ${announced.length - reviewer.length}; under another id — ${reviewer.length}`,
  )
  const entered = review.findIndex((m) => m.method === 'item/started' && m.params.item.type === 'enteredReviewMode')
  check(
    "enteredReviewMode comes before any other turn's start",
    entered !== -1 && reviewer.every((m) => review.indexOf(m) > entered),
  )
  const items = review
    .filter((m) => m.method === 'item/completed' && m.params.threadId === sideId)
    .map((m) => m.params.item.type)
  check('the review turn completes', ended?.params.turn.status === 'completed', ended?.params.turn.status ?? 'no turn/completed')
  check(
    'it runs in review mode',
    items.includes('enteredReviewMode') && items.includes('exitedReviewMode'),
    items.join(', '),
  )
  const exited = review.find((m) => m.method === 'item/completed' && m.params.item.type === 'exitedReviewMode')
  check('the finding comes back', /Greeting lost its punctuation/.test(exited?.params.item.review ?? ''))
  check('no deprecation notice', !review.some((m) => m.method === 'deprecationNotice'))
  check(
    'the reviewed conversation is left as it is',
    !review.some((m) => m.params?.threadId === parentId),
    `${review.filter((m) => m.params?.threadId === parentId).length} notifications for it`,
  )
  check('the model saw the review rubric', requests.includes('review'), requests.join(', '))
  const named = review.find((m) => m.method === 'thread/name/updated' && m.params.threadId === sideId)
  check('thread/name/set names it while it runs', named?.params.threadName === 'Review of uncommitted changes')
  if (SHAPES) {
    for (const m of review.filter((m) => m.params?.threadId === sideId)) console.log(`shape ${JSON.stringify(m)}`)
  }

  // 4. Stored like any conversation, where the sidebar reads them.
  const listed = await request('thread/list', { cursor: null, limit: 50, archived: false })
  const row = listed.data.find((thread) => thread.id === sideId)
  check('thread/list lists the side thread', Boolean(row), row ? `name ${JSON.stringify(row.name)}` : '')
  console.log(`info  its stored preview — ${JSON.stringify(row?.preview ?? null)}`)
  const parentListed = listed.data.some((thread) => thread.id === parentId)
  console.log(`info  the reviewed conversation, which has no turn, listed: ${parentListed ? 'yes' : 'no'}`)

  // 5. Naming before anything is stored, which is why the adapter names last.
  const early = await request('thread/start', { cwd: repo, permissions: ':read-only' })
  const earlyNamed = await request('thread/name/set', { threadId: early.thread.id, name: 'Named first' }).then(
    () => 'accepted',
    (error) => `refused: ${error.message}`,
  )
  const earlyListed = (await request('thread/list', { cursor: null, limit: 50, archived: false })).data.some(
    (thread) => thread.id === early.thread.id,
  )
  console.log(`info  thread/name/set before any turn — ${earlyNamed}; listed afterwards: ${earlyListed ? 'yes' : 'no'}`)

  // 6. Stopping a review. Codex checks `turn/interrupt` against the turn it
  //    holds as running, which during a review is the reviewer's forwarded
  //    one; the review then ends under its own turn, marked interrupted.
  holdReviewMs = 10_000
  const stopped = await request('thread/start', { cwd: repo, permissions: ':read-only' })
  const stoppedId = stopped.thread.id
  mark = heard.length
  const running = await request('review/start', {
    threadId: stoppedId,
    target: { type: 'uncommittedChanges' },
    delivery: 'inline',
  })
  const reviewerStart = await until((m) => m.method === 'turn/started' && m.params.threadId === stoppedId, 20_000).catch(
    () => null,
  )
  const byReview = await request('turn/interrupt', { threadId: stoppedId, turnId: running.turn.id }).then(
    () => 'accepted',
    (error) => `refused: ${error.message}`,
  )
  console.log(`info  turn/interrupt naming the review's turn — ${byReview}`)
  const byReviewer = reviewerStart
    ? await request('turn/interrupt', { threadId: stoppedId, turnId: reviewerStart.params.turn.id }).then(
        () => 'accepted',
        (error) => `refused: ${error.message}`,
      )
    : 'no reviewer turn was announced'
  check("turn/interrupt naming the reviewer's turn stops the review", byReviewer === 'accepted', byReviewer)
  const halted = await until((m) => m.method === 'turn/completed' && m.params.threadId === stoppedId, 20_000).catch(
    () => null,
  )
  holdReviewMs = 0
  check(
    'a stopped review ends under its own turn',
    halted?.params.turn.id === running.turn.id && halted?.params.turn.status === 'interrupted',
    halted ? `${halted.params.turn.id === running.turn.id ? 'its own turn' : 'another turn'}, ${halted.params.turn.status}` : 'no turn/completed',
  )
  const after = since(mark).filter((m) => m.params?.threadId === stoppedId && m.method === 'item/completed')
  console.log(`info  a stopped review's items — ${after.map((m) => m.params.item.type).join(', ')}`)
  if (SHAPES) {
    for (const m of since(mark).filter((m) => m.params?.threadId === stoppedId)) console.log(`shape ${JSON.stringify(m)}`)
  }

  //    Before the reviewer has started there is no turn to name; a stop naming
  //    none is Codex's "startup interrupt", which checks nothing.
  holdReviewMs = 10_000
  const unstarted = await request('thread/start', { cwd: repo, permissions: ':read-only' })
  const earlyId = unstarted.thread.id
  mark = heard.length
  const earlyReview = await request('review/start', {
    threadId: earlyId,
    target: { type: 'uncommittedChanges' },
    delivery: 'inline',
  })
  const reviewerSeen = since(mark).some((m) => m.method === 'turn/started' && m.params.threadId === earlyId)
  const byNothing = await request('turn/interrupt', { threadId: earlyId, turnId: '' }).then(
    () => 'accepted',
    (error) => `refused: ${error.message}`,
  )
  const earlyEnd = await until((m) => m.method === 'turn/completed' && m.params.threadId === earlyId, 20_000).catch(
    () => null,
  )
  holdReviewMs = 0
  check(
    'a stop naming no turn stops a review',
    byNothing === 'accepted' && earlyEnd?.params.turn.id === earlyReview.turn.id && earlyEnd?.params.turn.status === 'interrupted',
    `${byNothing}; the reviewer had ${reviewerSeen ? '' : 'not '}started when it was sent`,
  )

  // 7. A sandbox the configuration set, with no profile active: started
  //    again on its mode it is the same sandbox; on the profile named after
  //    it, it is not (the adapter's ThreadState.sandbox).
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const configured = await request('thread/start', { cwd: repo })
  const byMode = await request('thread/start', { cwd: repo, sandbox: 'workspace-write' })
  const byProfile = await request('thread/start', { cwd: repo, permissions: ':workspace' })
  check(
    'a sandbox the configuration set is started again on its mode',
    configured.activePermissionProfile === null && same(byMode.sandbox, configured.sandbox),
    `network ${configured.sandbox.networkAccess}, ${configured.sandbox.writableRoots?.length ?? 0} writable root(s)`,
  )
  console.log(
    `info  control: on the profile named after it — ${same(byProfile.sandbox, configured.sandbox) ? 'the same sandbox' : `network ${byProfile.sandbox.networkAccess}, ${byProfile.sandbox.writableRoots?.length ?? 0} writable root(s)`}`,
  )

  // 8. The control: detached delivery on the same app-server.
  mark = heard.length
  const detached = await request('review/start', {
    threadId: parentId,
    target: { type: 'uncommittedChanges' },
    delivery: 'detached',
  }).then(
    (result) => `accepted, review thread ${result.reviewThreadId === parentId ? 'is the parent' : 'is new'}`,
    (error) => `refused: ${error.message}`,
  )
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const notice = since(mark).find((m) => m.method === 'deprecationNotice')
  console.log(`info  control: detached review/start — ${detached}`)
  console.log(`info  control: deprecationNotice — ${notice ? JSON.stringify(notice.params.summary) : 'none'}`)
} catch (error) {
  check('the sequence ran', false, error instanceof Error ? error.message : String(error))
} finally {
  // Codex is still writing its home when it is told to stop; the folder goes
  // once the process has.
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill()
  await exited
  gateway.close()
  if (!KEEP) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed on ${version}`)
process.exit(failed.length === 0 ? 0 : 1)

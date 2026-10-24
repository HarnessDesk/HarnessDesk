import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, chmodSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const fixture = async () => {
  const module = await import(new URL('../src/git-gateway/index.js', import.meta.url).href).catch(() => ({}))
  assert.equal(typeof module.GitGateway, 'function', 'shared host gateway exists')
  const root = mkdtempSync(join(tmpdir(), 'hd-gateway-')), worker = join(root, 'worker'), remote = join(root, 'remote.git'), decoy = join(root, 'decoy.git')
  git(root, 'init', '--initial-branch=worker', worker); git(root, 'init', '--bare', remote); git(root, 'init', '--bare', decoy)
  git(worker, 'config', 'user.name', 'Jane Doe'); git(worker, 'config', 'user.email', 'dev@example.com')
  writeFileSync(join(worker, 'file'), 'Reviewed content'); git(worker, 'add', '.'); git(worker, 'commit', '-m', 'Fixture')
  git(worker, 'remote', 'add', 'origin', decoy)
  const options = { directory: join(root, 'host'), localRemote: (_repository: string) => remote }
  const gateway = new module.GitGateway(options)
  const request = { repository: 'acme/widgets', branch: 'worker', sha: git(worker, 'rev-parse', 'HEAD'), tree: git(worker, 'rev-parse', 'HEAD^{tree}'),
    objectStore: join(worker, '.git'), previousSha: null, requester: { kind: 'lead-goal', id: 'goal-1' } }
  return { root, worker, remote, decoy, options, gateway, request, module }
}
// A separate HTTP receive-pack process exercises both authentication and
// remote hooks without inheriting the gateway client's command-line config.
const serveGit = async (root: string, authenticated = false) => {
  let challenges = 0, authorized = 0
  const server = createServer((request, response) => {
    if (authenticated && request.headers.authorization !== `Basic ${Buffer.from('fixture:fixture-token').toString('base64')}`) {
      challenges++; response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' }); response.end(); return
    }
    authorized++
    const url = new URL(request.url!, 'http://127.0.0.1')
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
    const child = spawn('git', ['http-backend'], { env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: request.method!, PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers['content-type'] ?? '', REMOTE_USER: 'fixture' } })
    request.pipe(child.stdin); child.stdin.on('error', () => {})
    const chunks: Buffer[] = []; child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.resume()
    child.on('close', code => {
      const out = Buffer.concat(chunks), headerEnd = out.indexOf('\r\n\r\n')
      if (code || headerEnd < 0) { response.writeHead(500); response.end(); return }
      let status = 200
      const headers: Record<string, string> = {}
      for (const line of out.subarray(0, headerEnd).toString().split('\r\n')) {
        const colon = line.indexOf(':'), key = line.slice(0, colon).toLowerCase(), value = line.slice(colon + 1).trim()
        if (key === 'status') status = Number(value.split(' ')[0]); else headers[key] = value
      }
      response.writeHead(status, headers); response.end(out.subarray(headerEnd + 4))
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}/remote.git`, counts: () => ({ challenges, authorized }),
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}
test('mirror ignores worker programs, rewrites and remotes; ledger survives reopening', async () => {
  const f = await fixture(), marker = join(f.root, 'marker'), hook = join(f.worker, '.git', 'hooks', 'pre-push')
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
  git(f.worker, 'config', 'credential.helper', `!touch '${marker}'`); git(f.worker, 'config', 'core.askPass', hook)
  git(f.worker, 'config', `url.${f.decoy}.insteadOf`, f.remote); git(f.worker, 'config', `url.${f.decoy}.pushInsteadOf`, f.remote)
  git(f.worker, 'config', 'http.proxy', 'http://example.invalid:1')
  await f.gateway.push(f.request)
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/worker'), f.request.sha)
  assert.equal(git(f.decoy, 'for-each-ref', '--format=%(refname)'), '')
  assert.equal(existsSync(marker), false)
  assert.deepEqual(await new f.module.GitGateway(f.options).attribute('acme/widgets', 'worker', f.request.sha), f.request.requester)
  const rows = await f.gateway.record({ repository: f.request.repository, limit: 100 })
  assert.equal(rows.length, 2); assert.equal(rows[0].outcome, 'ok'); assert.equal(rows[0].previousSha, null)
  assert.equal(rows[0].op, 'push'); assert.equal(typeof rows[0].at, 'number')
})
test('mirror refuses a reviewed tree mismatch, missing SHA and corrupt objects', async () => {
  for (const mode of ['tree', 'sha', 'corrupt']) {
    const f = await fixture()
    if (mode === 'corrupt') { const path = join(f.worker, '.git', 'objects', f.request.sha.slice(0, 2), f.request.sha.slice(2)); chmodSync(path, 0o600); writeFileSync(path, 'corrupt') }
    await assert.rejects(f.gateway.push({ ...f.request, ...(mode === 'tree' ? { tree: 'a'.repeat(40) } : mode === 'sha' ? { sha: 'b'.repeat(40) } : {}) }))
    assert.equal(git(f.remote, 'for-each-ref', '--format=%(refname)'), '')
    assert.equal(await f.gateway.attribute('acme/widgets', 'worker', f.request.sha), 'outside')
    const [row] = await f.gateway.record({ repository: f.request.repository, limit: 100 })
    assert.equal(row.outcome, mode === 'corrupt' ? 'failed' : 'refused')
  }
})
test('mirror enforces create-only and owned fast-forward leases', async () => {
  const f = await fixture(); await f.gateway.push(f.request)
  await assert.rejects(f.gateway.push(f.request), /branch-exists-not-owned/)
  git(f.worker, 'commit', '--allow-empty', '-m', 'Next')
  const next = { ...f.request, previousSha: f.request.sha, sha: git(f.worker, 'rev-parse', 'HEAD') }
  await f.gateway.push(next)
  await assert.rejects(f.gateway.push({ ...next, sha: f.request.sha }), /owned-head-changed|not-fast-forward/)
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/worker'), next.sha)
})
test('forge operations use explicit pinned repository and host cwd with a ledger', async () => {
  const f = await fixture(), calls: any[] = []
  const gateway = new f.module.GitGateway({ ...f.options, gh: async (cwd: string, args: string[], env: any) => {
    calls.push({ cwd, args, env }); return { stdout: args[1] === 'create' ? 'https://github.com/acme/widgets/pull/7' : '[]', stderr: '', exitCode: 0 }
  } })
  await gateway.createPullRequest({ ...f.request, title: 'Fixture', body: 'Fixture' })
  await gateway.findPullRequest(f.request)
  assert.equal(calls.length, 2)
  for (const call of calls) { assert.equal(call.cwd, join(f.root, 'host')); assert.ok(call.args.includes('--repo')); assert.ok(call.args.includes('acme/widgets')); assert.equal(call.env.GH_REPO, undefined) }
  assert.equal((await gateway.record({ repository: f.request.repository, limit: 100 })).length, 2)
})

test('mirror intake accepts the exact commit from a linked worktree object store', async () => {
  const f = await fixture(), checkout = join(f.root, 'checkout')
  git(f.worker, 'worktree', 'add', '-b', 'linked-worker', checkout)
  const objectStore = git(checkout, 'rev-parse', '--absolute-git-dir')
  await f.gateway.push({ ...f.request, branch: 'linked-worker', objectStore })
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/linked-worker'), f.request.sha)
})
test('an update lease refuses a concurrent writer after ancestry validation', async () => {
  const f = await fixture(); await f.gateway.push(f.request)
  git(f.worker, 'commit', '--allow-empty', '-m', 'Reviewed next')
  const next = { ...f.request, previousSha: f.request.sha, sha: git(f.worker, 'rev-parse', 'HEAD') }
  const foreign = git(f.worker, 'commit-tree', f.request.tree, '-m', 'Foreign rewrite')
  await assert.rejects(f.gateway.push(next, { beforePush: async () => { git(f.worker, 'push', '--force', f.remote, `${foreign}:refs/heads/worker`) } }), (error: any) => error.code === 1 && /stale info|rejected/.test(error.stdout))
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/worker'), foreign)
  assert.equal(await f.gateway.attribute('acme/widgets', 'worker', next.sha), 'outside')
  assert.equal((await f.gateway.record({ repository: f.request.repository, limit: 1 }))[0].outcome, 'rejected')
})

test('transfer fsck refuses a content-addressed commit with a missing author', async () => {
  const f = await fixture()
  const sha = execFileSync('git', ['-C', f.worker, 'hash-object', '--literally', '-t', 'commit', '-w', '--stdin'], {
    encoding: 'utf8', input: `tree ${f.request.tree}\ncommitter Jane Doe <dev@example.com> 1700000000 +0000\n\nInvalid fixture\n`,
  }).trim()
  await assert.rejects(f.gateway.push({ ...f.request, sha }), /missingAuthor|fsck error/)
  assert.equal(git(f.remote, 'for-each-ref', '--format=%(refname)'), '')
})

test('gateway supplies the worker object identity without executing worker programs', async () => {
  const f = await fixture(), marker = join(f.root, 'inspect-marker')
  git(f.worker, 'config', 'core.fsmonitor', `touch '${marker}'`)
  assert.equal(typeof f.gateway.inspectCheckout, 'function')
  const inspected = await f.gateway.inspectCheckout(f.worker)
  assert.equal(inspected.sha, f.request.sha); assert.equal(inspected.tree, f.request.tree)
  assert.equal(inspected.branch, 'worker'); assert.equal(realpathSync(inspected.objectStore), realpathSync(join(f.worker, '.git')))
  assert.equal(existsSync(marker), false)
})

test('gateway identity reads support a detached project beside a linked worker', async () => {
  const f = await fixture(), checkout = join(f.root, 'linked')
  git(f.worker, 'worktree', 'add', '-b', 'reviewed-worker', checkout)
  git(f.worker, 'checkout', '--detach')
  const project = await f.gateway.inspectCheckout(f.worker), worker = await f.gateway.inspectCheckout(checkout)
  assert.equal(project.branch, null); assert.equal(worker.branch, 'reviewed-worker')
  assert.equal(project.commonDir, worker.commonDir)
})

test('git record chains exact lines, detects edits and filters newest first', async () => {
  const f = await fixture()
  await f.gateway.push(f.request)
  await assert.rejects(f.gateway.push(f.request))
  const record = f.gateway.gitRecord
  assert.deepEqual(await record.verify(f.request.repository), { ok: true, damaged: 0 })
  assert.deepEqual(await record.verify(), { ok: true, damaged: 0 })
  const rows = await record.list({ repository: f.request.repository, limit: 100 })
  assert.equal(rows[0].outcome, 'refused')
  assert.equal((await record.list({ repository: f.request.repository, view: 'refused', limit: 100 })).length, 1)
  assert.deepEqual(await record.list({ repository: f.request.repository, before: rows[0].id, limit: 1 }), [rows[1]])
  const path = join(f.root, 'host', 'git-record', 'acme__widgets.ndjson')
  const lines = readFileSync(path, 'utf8').split('\n')
  lines[0] = lines[0]!.replace('lead-goal', 'person')
  writeFileSync(path, lines.join('\n'))
  assert.deepEqual(await record.verify(f.request.repository), { ok: false, line: 1, damaged: 1 })
  assert.equal(await record.attribute(f.request.repository, 'worker', f.request.sha), 'outside')
})

test('startup reconciles interrupted push intents against the pinned remote', async () => {
  for (const present of [true, false]) {
    const f = await fixture()
    if (present) git(f.worker, 'push', f.remote, `${f.request.sha}:refs/heads/worker`)
    await f.gateway.ready()
    await f.gateway.gitRecord.append({ id: 'interrupted', op: 'push', repository: f.request.repository, branch: 'worker',
      sha: f.request.sha, previousSha: null, lease: null, requester: f.request.requester, approval: null, at: 1, outcome: 'intent' })
    const reopened = new f.module.GitGateway(f.options)
    await reopened.ready()
    const rows = await reopened.record({ repository: f.request.repository, limit: 100 })
    assert.equal(rows.length, 2)
    assert.equal(rows[0].id, 'interrupted')
    assert.equal(rows[0].outcome, present ? 'ok' : 'failed')
    assert.equal(rows[0].reason, present ? 'reconciled' : 'interrupted')
    assert.equal(await reopened.attribute(f.request.repository, 'worker', f.request.sha) === 'outside', !present)
  }
})

test('attribution retains requester metadata, records outside heads once and changes writer', async () => {
  const f = await fixture()
  const requester = { kind: 'session', id: 'session-1', seat: { label: 'Writer', role: 'implement', round: 1, team: 'Demo' },
    conversation: { runtime: 'demo', sessionId: 'session-1', title: 'Fixture' } }
  const gateway = new f.module.GitGateway({ ...f.options, gh: async (_cwd: string, args: string[]) => ({ stdout: JSON.stringify(args[0] === 'api' ? { protected: false } : { defaultBranchRef: { name: 'main' } }), stderr: '', exitCode: 0 }) })
  await gateway.push({ ...f.request, requester })
  assert.deepEqual(await gateway.attribute(f.request.repository, 'worker', f.request.sha), requester)
  await gateway.observe(f.request.repository, 'worker', f.request.sha, null)
  assert.equal((await gateway.record({ repository: f.request.repository, view: 'outside', limit: 100 })).length, 0)
  git(f.worker, 'commit', '--allow-empty', '-m', 'Outside')
  const outside = git(f.worker, 'rev-parse', 'HEAD')
  git(f.worker, 'push', f.remote, `${outside}:refs/heads/worker`)
  assert.equal(await gateway.attribute(f.request.repository, 'worker', outside), 'outside')
  await Promise.all([gateway.observe(f.request.repository, 'worker', outside, f.request.sha), gateway.observe(f.request.repository, 'worker', outside, f.request.sha)])
  const rows = await gateway.record({ repository: f.request.repository, view: 'outside', limit: 100 })
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].requester, { kind: 'outside' })
  git(f.worker, 'commit', '--allow-empty', '-m', 'Another writer')
  const next = { ...f.request, sha: git(f.worker, 'rev-parse', 'HEAD'), previousSha: outside, requester: { kind: 'person', id: 'person-1' } }
  await gateway.push(next)
  assert.deepEqual(await gateway.attribute(f.request.repository, 'worker', next.sha), next.requester)
})

test('session default and protected branches are refused and stale leases are rejected in the record', async () => {
  const f = await fixture()
  const gateway = new f.module.GitGateway({ ...f.options, gh: async (_cwd: string, args: string[]) => ({ stdout: JSON.stringify(args[0] === 'api' ? { protected: false } : { defaultBranchRef: { name: 'main' } }), stderr: '', exitCode: 0 }) })
  for (const branch of ['main', 'development']) {
    await assert.rejects(gateway.push({ ...f.request, branch, protectedBases: ['development'], requester: { kind: 'session', id: 's' } }), /protected|default/)
  }
  await gateway.push(f.request)
  git(f.worker, 'commit', '--allow-empty', '-m', 'Next')
  await assert.rejects(gateway.push({ ...f.request, sha: git(f.worker, 'rev-parse', 'HEAD'), previousSha: 'a'.repeat(40) }), /owned-head-changed/)
  const rows = await gateway.record({ repository: f.request.repository, limit: 100 })
  assert.equal(rows[0].outcome, 'rejected')
  assert.equal(rows.filter((row: any) => row.outcome === 'refused').length, 2)
})

test('repository pins survive reopening and never follow checkout remotes', async () => {
  const f = await fixture()
  await f.gateway.pins.pin(f.worker, 'acme/widgets', { kind: 'person', id: 'person-1' })
  git(f.worker, 'remote', 'set-url', 'origin', f.decoy)
  assert.equal(await new f.module.GitGateway(f.options).pins.pinned(f.worker), 'acme/widgets')
  await assert.rejects(f.gateway.pins.pin(f.worker, 'acme/decoy', { kind: 'person', id: 'person-1' }), /already-pinned/)
  await assert.rejects(f.gateway.pins.pin(f.worker, '../decoy', { kind: 'person', id: 'person-1' }), /repository-invalid/)
  await assert.rejects(f.gateway.createPullRequest({ ...f.request, repository: '--evil', title: 'Fixture', body: 'Fixture' }), /repository-invalid/)
})

test('repository queues allow independent writes while serializing the same repository', async () => {
  const f = await fixture()
  let release!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { started = resolve })
  const calls: string[] = []
  const gateway = new f.module.GitGateway({ ...f.options, gh: async (_cwd: string, args: string[]) => {
    const repo = args[args.indexOf('--repo') + 1]!; calls.push(repo)
    if (repo === 'acme/widgets') { started(); await held }
    return { stdout: '', stderr: '', exitCode: 0 }
  } })
  const first = gateway.updatePullRequest({ repository: 'acme/widgets', number: 1, title: 'Fixture', requester: f.request.requester })
  await entered
  const same = gateway.updatePullRequest({ repository: 'Acme/Widgets', number: 2, title: 'Fixture', requester: f.request.requester })
  try {
    await gateway.updatePullRequest({ repository: 'acme/other', number: 1, title: 'Fixture', requester: f.request.requester })
    assert.deepEqual(calls, ['acme/widgets', 'acme/other'])
  } finally { release() }
  await Promise.all([first, same])
})


test('all forge writes journal intent and outcome and fake gh enforces a head-bound merge', async () => {
  const f = await fixture(), state = join(f.root, 'forge.json'), trace = join(f.root, 'forge.ndjson')
  writeFileSync(state, JSON.stringify({ repo: 'acme/widgets', publicationHead: f.request.sha, pulls: [], issues: [{ number: 9, comments: [] }] }))
  const execute = promisify(execFile)
  const originalRepo = process.env.GH_REPO, originalHost = process.env.GH_HOST
  process.env.GH_REPO = 'acme/decoy'; process.env.GH_HOST = 'example.invalid'
  const gateway = new f.module.GitGateway({ ...f.options, gh: async (cwd: string, args: string[], env: any) => {
    assert.equal(env.GH_REPO, undefined); assert.equal(env.GH_HOST, undefined)
    assert.equal(existsSync(join(cwd, '.git')), false)
    const rows = await gateway.gitRecord.list({ repository: f.request.repository, limit: 100 })
    assert.equal(rows[0].outcome, 'intent', 'intent is durable before fake gh executes')
    try { return { ...await execute(process.execPath, [fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url)), ...args],
      { cwd, env: { ...env, FAKE_GH_STATE: state, FAKE_GH_TRACE: trace } }), exitCode: 0 } }
    catch (error: any) { return { stdout: error.stdout, stderr: error.stderr, exitCode: error.code } }
  } })
  if (originalRepo === undefined) delete process.env.GH_REPO; else process.env.GH_REPO = originalRepo
  if (originalHost === undefined) delete process.env.GH_HOST; else process.env.GH_HOST = originalHost
  const target = { repository: f.request.repository, number: 1, requester: f.request.requester }
  await gateway.createPullRequest({ ...f.request, title: 'Fixture', body: 'Fixture' })
  await gateway.updatePullRequest({ ...target, title: 'Updated', body: 'Updated body' })
  await gateway.comment({ ...target, subject: 'pullRequest', body: 'PR comment' })
  await gateway.comment({ ...target, subject: 'issue', number: 9, body: 'Issue comment' })
  await gateway.review({ ...target, event: 'approve', body: 'Reviewed' })
  await assert.rejects(gateway.mergePullRequest({ ...target, head: 'b'.repeat(40), method: 'squash' }), /head|forge/)
  await gateway.mergePullRequest({ ...target, head: f.request.sha, method: 'squash' })
  const rows = (await gateway.record({ repository: f.request.repository, limit: 100 })).filter((row: any) => row.op !== 'issue.comment')
  assert.equal(rows.length, 12)
  for (const row of rows.filter((row: any) => row.outcome === 'intent')) {
    const pair = rows.filter((other: any) => other.id === row.id)
    assert.equal(pair.length, 2); assert.notEqual(pair[0].outcome, 'intent')
  }
  assert.equal(rows.find((row: any) => row.outcome === 'rejected')?.op, 'pr.merge')
  const calls = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(calls.length, 7)
  for (const call of calls) {
    assert.equal(call.argv[call.argv.indexOf('--repo') + 1], 'acme/widgets')
    assert.equal(realpathSync(call.cwd), realpathSync(join(f.root, 'host')))
  }
  const saved = JSON.parse(readFileSync(state, 'utf8'))
  assert.equal(saved.pulls[0].title, 'Updated'); assert.equal(saved.pulls[0].merged, true)
  assert.equal(saved.pulls[0].reviews.length, 1); assert.equal(saved.pulls[0].comments.length, 1)
  assert.equal(saved.issues[0].comments.length, 1)
})

test('record pagination skips a complete operation and direct concurrent observations deduplicate', async () => {
  const f = await fixture()
  await f.gateway.push(f.request)
  const rows = await f.gateway.record({ repository: f.request.repository, limit: 1 })
  assert.deepEqual(await f.gateway.record({ repository: f.request.repository, limit: 1, before: rows[0].id }), [])
  await Promise.all(Array.from({ length: 3 }, () => f.gateway.gitRecord.observe(f.request.repository, 'outside', f.request.sha, null)))
  assert.equal((await f.gateway.gitRecord.list({ repository: f.request.repository, view: 'outside', limit: 10 })).length, 1)
})

test('session protection is checked at the pinned forge and cannot be bypassed by omitting protected bases', async () => {
  const f = await fixture(), calls: string[][] = []
  const gateway = new f.module.GitGateway({ ...f.options, gh: async (_cwd: string, args: string[]) => {
    calls.push(args)
    return { stdout: JSON.stringify(args[0] === 'api' ? { protected: true } : { defaultBranchRef: { name: 'main' } }), stderr: '', exitCode: 0 }
  } })
  await assert.rejects(gateway.push({ ...f.request, requester: { kind: 'session', id: 'session-1' } }), /protected-branch/)
  assert.ok(calls.some(args => args.includes('repos/acme/widgets/branches/worker')))
  assert.equal((await gateway.record({ repository: f.request.repository, limit: 1 }))[0].outcome, 'refused')
})

test('invalid forge arguments are refused durably before invoking gh', async () => {
  const f = await fixture(); let calls = 0
  const gateway = new f.module.GitGateway({ ...f.options, gh: async () => { calls++; return { stdout: '', stderr: '', exitCode: 0 } } })
  const target = { repository: f.request.repository, requester: f.request.requester, number: 1 }
  const invalid = [
    () => gateway.mergePullRequest({ ...target, head: '', method: 'squash' }),
    () => gateway.mergePullRequest({ ...target, head: f.request.sha, method: 'x' }),
    () => gateway.review({ ...target, body: 'Fixture', event: 'x' }),
    () => gateway.review({ ...target, body: 7, event: 'approve' }),
    ...[0, -1, 1.5, NaN].map(number => () => gateway.updatePullRequest({ ...target, number, title: 'Fixture' })),
    ...['bad..branch', 'bad.lock', 'bad branch', '-option', 'x@{y', 'x//y', ''].map(branch => () => gateway.createPullRequest({ ...target, branch, title: 'Fixture', body: 'Fixture' })),
    () => gateway.createPullRequest({ ...target, branch: 'worker', base: 'bad..base', title: 'Fixture', body: 'Fixture' }),
    () => gateway.createPullRequest({ ...target, branch: 'worker', title: '', body: 'Fixture' }),
    () => gateway.createPullRequest({ ...target, branch: 'worker', title: 'Fixture', body: 'Fixture', draft: 'yes' }),
    () => gateway.comment({ ...target, subject: 'x', body: 'Fixture' }),
    () => gateway.updatePullRequest({ ...target, title: 'bad\0title' }),
    () => gateway.updatePullRequest(target),
    () => gateway.updatePullRequest({ ...target, requester: null, title: 'Fixture' }),
    () => gateway.updatePullRequest({ ...target, requester: { kind: 'session', id: 7 }, title: 'Fixture' }),
    () => gateway.updatePullRequest({ ...target, requester: { kind: 'x', id: 'fixture' }, title: 'Fixture' }),
    () => gateway.updatePullRequest({ ...target, requester: { kind: 'session', id: 'fixture', seat: { label: 'Fixture', role: null, team: null, round: -1 } }, title: 'Fixture' }),
    () => gateway.updatePullRequest({ ...target, approval: { by: 'x' }, title: 'Fixture' }),
    () => gateway.updatePullRequest({ ...target, approval: false, title: 'Fixture' }),
    () => gateway.updatePullRequest({ ...target, approval: { by: 'person', at: 1.5 }, title: 'Fixture' }),
  ]
  for (const invoke of invalid) {
    await assert.rejects(invoke(), /target-invalid/)
    assert.equal((await gateway.record({ repository: target.repository, limit: 1 }))[0].outcome, 'refused')
  }
  assert.equal(calls, 0)
})

test('repository case shares the queue, mirror, record and pin; ambiguous owners are refused', async () => {
  const f = await fixture()
  await f.gateway.push({ ...f.request, repository: 'Acme/Widgets' })
  assert.deepEqual(await f.gateway.attribute('acme/widgets', 'worker', f.request.sha), f.request.requester)
  assert.equal((await f.gateway.record({ repository: 'ACME/WIDGETS', limit: 10 }))[0].repository, 'acme/widgets')
  await f.gateway.pins.pin(f.worker, 'Acme/Widgets', f.request.requester)
  await f.gateway.pins.pin(f.worker, 'acme/widgets', f.request.requester)
  assert.equal(await f.gateway.pins.pinned(f.worker), 'acme/widgets')
  for (const repository of ['a_b/c', 'a__b/c', '-acme/widgets', 'acme-/widgets'])
    await assert.rejects(f.gateway.push({ ...f.request, repository }), /repository-invalid/)
})

test('a remote hook decline is refused rather than a lease rejection', async () => {
  const f = await fixture()
  writeFileSync(join(f.remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho "fixture declined: stale info" >&2\nexit 1\n', { mode: 0o755 })
  const http = await serveGit(f.root)
  try {
    const gateway = new f.module.GitGateway({ ...f.options, localRemote: () => http.url })
    await assert.rejects(gateway.push(f.request), /declined/)
    const [row] = await gateway.record({ repository: f.request.repository, limit: 1 })
    assert.equal(row.outcome, 'refused'); assert.match(row.reason, /declined/)
  } finally { await http.close() }
})


test('HTTP push authenticates only through the host one-shot helper and ignores worker proxy', async () => {
  const f = await fixture(), http = await serveGit(f.root, true)
  const workerMarker = join(f.root, 'worker-helper'), hostMarker = join(f.root, 'host-helper'), hostConfig = join(f.root, 'host.config')
  const helper = join(f.root, 'host-credential')
  writeFileSync(helper, `#!/bin/sh\necho "$1" >> '${hostMarker}'\nif [ "$1" = get ]; then printf 'username=fixture\\npassword=fixture-token\\n'; fi\n`, { mode: 0o700 })
  writeFileSync(hostConfig, `[credential]\n helper = ${helper}\n`)
  git(f.worker, 'config', 'credential.helper', `!touch '${workerMarker}'`)
  git(f.worker, 'config', 'http.proxy', 'http://127.0.0.1:1')
  const saved = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = hostConfig
  const gateway = new f.module.GitGateway({ ...f.options, localRemote: () => http.url })
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved
  try {
    await gateway.push(f.request)
    assert.ok(http.counts().challenges > 0); assert.ok(http.counts().authorized > 0)
    assert.match(readFileSync(hostMarker, 'utf8'), /get/)
    assert.equal(existsSync(workerMarker), false)
    assert.equal(git(f.remote, 'rev-parse', 'refs/heads/worker'), f.request.sha)
  } finally { await http.close() }
})

test('mirror config is restored and recorded before every network operation', async () => {
  const f = await fixture()
  await f.gateway.push(f.request)
  const { createHash } = await import('node:crypto')
  const mirror = join(f.root, 'host', `${createHash('sha256').update(f.request.repository).digest('hex')}.git`)
  const marker = join(f.root, 'mirror-helper')
  const corrupt = () => writeFileSync(join(mirror, 'config'), `[core]\n bare = true\n hooksPath = ${f.worker}/.git/hooks\n sshCommand = touch ${marker}\n[remote "origin"]\n url = ${f.decoy}\n[url "${f.decoy}"]\n insteadOf = ${f.remote}\n[credential]\n helper = !touch ${marker}\n[http]\n proxy = http://127.0.0.1:1\n[include]\n path = ${f.worker}/.git/config\n`)
  corrupt()
  assert.equal(await f.gateway.remoteHead('Acme/Widgets', 'worker'), f.request.sha)
  assert.doesNotMatch(readFileSync(join(mirror, 'config'), 'utf8'), /remote|url |credential|sshCommand|include|proxy/)
  git(f.worker, 'commit', '--allow-empty', '-m', 'Next')
  corrupt()
  await f.gateway.push({ ...f.request, sha: git(f.worker, 'rev-parse', 'HEAD'), previousSha: f.request.sha }, { beforePush: async () => corrupt() })
  assert.equal(existsSync(marker), false)
  const rows = await f.gateway.record({ repository: f.request.repository, limit: 100 })
  assert.equal(rows.filter((row: any) => row.reason === 'git-gateway-mirror-config-reset').length, 3)
})

// Faults happen after real receive-pack has updated the local bare remote.
// The wrapper delegates every command to the real git; only its replies fail.
test('accepted pushes survive verification loss or ambiguous push exit without outside attribution', async () => {
  for (const fault of ['verify-once', 'verify-offline', 'push-exit', 'push-signal']) {
    const f = await fixture(), bin = join(f.root, 'bin'), marker = join(f.root, 'accepted'), failed = join(f.root, 'verification-failed')
    const { mkdirSync } = await import('node:fs'); mkdirSync(bin)
    const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim()
    writeFileSync(join(bin, 'git'), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process'),fs=require('node:fs');
const args=process.argv.slice(2), accepted=${JSON.stringify(marker)}, failed=${JSON.stringify(failed)};
if(args.includes('ls-remote')&&fs.existsSync(accepted)&&${JSON.stringify(fault)}.startsWith('verify')&&(${JSON.stringify(fault)}==='verify-offline'||!fs.existsSync(failed))){fs.writeFileSync(failed,'yes');process.exit(1)}
const result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});
if(args.includes('push')&&result.status===0){fs.writeFileSync(accepted,'yes');if(${JSON.stringify(fault)}==='push-exit')process.exit(1);if(${JSON.stringify(fault)}==='push-signal')process.kill(process.pid,'SIGTERM')}
process.exit(result.status??1);\n`, { mode: 0o755 })
    const saved = process.env.PATH; process.env.PATH = `${bin}:${saved}`
    const gateway = new f.module.GitGateway(f.options)
    process.env.PATH = saved
    if (fault === 'verify-offline') await assert.rejects(gateway.push(f.request)); else await gateway.push(f.request)
    assert.equal(git(f.remote, 'rev-parse', 'refs/heads/worker'), f.request.sha)
    const rows = await gateway.record({ repository: f.request.repository, limit: 100 })
    assert.ok(rows.every((row: any) => ['ok', 'intent'].includes(row.outcome)))
    assert.equal(rows[0].outcome, fault === 'verify-offline' ? 'intent' : 'ok')
    await gateway.observe(f.request.repository, 'worker', f.request.sha, null)
    assert.equal((await gateway.record({ repository: f.request.repository, view: 'outside', limit: 100 })).length, 0)
    if (fault === 'verify-offline') {
      process.env.PATH = `${bin}:${saved}`
      const offline = new f.module.GitGateway(f.options)
      process.env.PATH = saved
      await offline.ready()
      assert.equal((await offline.record({ repository: f.request.repository, limit: 1 }))[0].outcome, 'intent')
    }
    const reopened = new f.module.GitGateway(f.options); await reopened.ready()
    assert.equal((await reopened.record({ repository: f.request.repository, limit: 1 }))[0].outcome, 'ok')
    assert.equal(await reopened.hasSucceededPush({ ...f.request }), true)
  }
})

import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, chmodSync, realpathSync } from 'node:fs'
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
  assert.deepEqual(await record.verify(f.request.repository), { ok: true })
  assert.deepEqual(await record.verify(), { ok: true })
  const rows = await record.list({ repository: f.request.repository, limit: 100 })
  assert.equal(rows[0].outcome, 'refused')
  assert.equal((await record.list({ repository: f.request.repository, view: 'refused', limit: 100 })).length, 1)
  assert.deepEqual(await record.list({ repository: f.request.repository, before: rows[0].id, limit: 1 }), [rows[1]])
  const path = join(f.root, 'host', 'git-record', 'acme__widgets.ndjson')
  const lines = readFileSync(path, 'utf8').split('\n')
  lines[0] = lines[0]!.replace('lead-goal', 'person')
  writeFileSync(path, lines.join('\n'))
  assert.deepEqual(await record.verify(f.request.repository), { ok: false, line: 2 })
  await assert.rejects(record.attribute(f.request.repository, 'worker', f.request.sha), /git-record-broken/)
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
  const same = gateway.updatePullRequest({ repository: 'acme/widgets', number: 2, title: 'Fixture', requester: f.request.requester })
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

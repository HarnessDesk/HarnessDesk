import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, chmodSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
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
  const rows = readFileSync(join(f.root, 'host', 'ledger.jsonl'), 'utf8').trim().split('\n').map(row => JSON.parse(row))
  assert.equal(rows.length, 1); assert.equal(rows[0].outcome, 'succeeded'); assert.equal(rows[0].previousSha, null)
  assert.equal(rows[0].op, 'push'); assert.equal(typeof rows[0].at, 'number')
})
test('mirror refuses a reviewed tree mismatch, missing SHA and corrupt objects', async () => {
  for (const mode of ['tree', 'sha', 'corrupt']) {
    const f = await fixture()
    if (mode === 'corrupt') { const path = join(f.worker, '.git', 'objects', f.request.sha.slice(0, 2), f.request.sha.slice(2)); chmodSync(path, 0o600); writeFileSync(path, 'corrupt') }
    await assert.rejects(f.gateway.push({ ...f.request, ...(mode === 'tree' ? { tree: 'a'.repeat(40) } : mode === 'sha' ? { sha: 'b'.repeat(40) } : {}) }))
    assert.equal(git(f.remote, 'for-each-ref', '--format=%(refname)'), '')
    assert.equal(await f.gateway.attribute('acme/widgets', 'worker', f.request.sha), 'unknown')
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
  assert.equal(readFileSync(join(f.root, 'host', 'ledger.jsonl'), 'utf8').trim().split('\n').length, 2)
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
  assert.equal(await f.gateway.attribute('acme/widgets', 'worker', next.sha), 'unknown')
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

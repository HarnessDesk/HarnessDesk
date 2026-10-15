import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createTemplateRig, TEMPLATE_TASK, TEMPLATE_PUBLISH_BRANCH } from './shots/template-rig.mjs'
import { GhFindingForge } from '../packages/server/dist/src/findings/forge.js'
import { markerOf, publicationKey, sha256 } from '../packages/server/dist/src/findings/publication.js'

test('the template rig restores only a legacy project record and keeps all transport local', { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-template-test-'))
  const rig = await createTemplateRig({ home: join(directory, 'home'), work: join(directory, 'work'), template: 'fix-and-review' })
  t.after(async () => { await rig.dispose(); rmSync(directory, { recursive: true, force: true }) })
  const project = JSON.parse(readFileSync(rig.stateFile, 'utf8')).workspaces[0]
  assert.deepEqual(Object.keys(project).sort(), ['id', 'lastOpenedAt', 'name', 'path'])
  assert.equal(project.path, rig.repo)
  assert.equal(rig.git('remote', 'get-url', 'origin'), join(directory, 'home', 'storefront.git'))
  assert.equal(rig.git('branch', '--show-current'), TEMPLATE_PUBLISH_BRANCH, 'publication starts on an existing feature branch')
  const runtimes = (await rig.host.call('host/hello', {})).runtimes
  assert.deepEqual(runtimes.map(one => one.provider).sort(), ['scripted-reviewer', 'scripted-writer'])
  assert.deepEqual(runtimes.map(one => one.presentation.name).sort(), ['Scripted reviewer', 'Scripted writer'])
  const publisher = runtimes.find(one => one.provider === 'scripted-writer')
  assert.ok(publisher.ceilings.publish, 'the scripted publisher can qualify the shipped publish step')
  assert.equal(runtimes.find(one => one.provider === 'scripted-reviewer').ceilings.publish, undefined, 'the reviewer cannot publish')
  assert.deepEqual(rig.errors, [])
  writeFileSync(join(rig.repo, 'rig-attempt.txt'), 'Attempt 1: retry transient responses.\n')
  rig.release('checks')
  const checked = execFileSync(process.execPath, ['.harnessdesk/rig-check.mjs'], { cwd: rig.repo, env: { TERM: 'dumb' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.match(checked, /Retry attempt passed/, 'the check does not depend on desk environment variables')
})

test('Side by side scripted attempts can declare the same file in their isolated checkouts (#1562)', { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-template-claims-'))
  const rig = await createTemplateRig({ home: join(directory, 'home'), work: join(directory, 'work') })
  t.after(async () => { await rig.dispose(); rmSync(directory, { recursive: true, force: true }) })
  const source = await rig.host.call('flow/source', { root: rig.repo, id: 'comparison' })
  const vars = { task: TEMPLATE_TASK }
  const preview = await rig.host.call('flow/preview', { root: rig.repo, source, vars })
  assert.ok(preview.token, JSON.stringify(preview.problems))
  const run = await rig.host.call('flow/start-goal', { root: rig.repo, source, vars, token: preview.token, sentence: TEMPLATE_TASK })
  const until = Date.now() + 30000
  let attempts
  do {
    assert.deepEqual(rig.errors, [], 'both scripted claim_work calls succeeded')
    const execution = await rig.host.call('flow/execution', { run: run.id })
    assert.notEqual(execution.state, 'stalled', execution.reason)
    attempts = (await rig.host.call('goal/read', { goal: run.goal })).board.intents.filter(one => one.role === 'competitor')
    if (attempts.length === 2 && attempts.every(one => one.files.includes('rig-attempt.txt'))) break
    await new Promise(done => setTimeout(done, 50))
  } while (Date.now() < until)
  assert.equal(attempts.length, 2)
  assert.ok(attempts.every(one => one.state === 'claimed' && one.files.includes('rig-attempt.txt')))
  assert.equal(new Set((await rig.host.call('goal/read', { goal: run.goal })).members.filter(one => one.role === 'competitor').map(one => one.checkout.cwd)).size, 2)
})

test('the disposable forge keeps its PR head and refuses every unscripted operation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-template-forge-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  execFileSync('git', ['init', '-b', 'main', directory], { stdio: 'pipe' })
  execFileSync('git', ['-C', directory, 'config', 'user.name', 'Jane Doe'])
  execFileSync('git', ['-C', directory, 'config', 'user.email', 'dev@example.com'])
  writeFileSync(join(directory, 'retry.txt'), 'Retry transient responses.\n')
  execFileSync('git', ['-C', directory, 'add', 'retry.txt'])
  execFileSync('git', ['-C', directory, 'commit', '-m', 'rig: initial retry'], { stdio: 'pipe' })
  const state = join(directory, 'forge.json')
  writeFileSync(state, JSON.stringify({ pr: null }))
  const run = (args, input = undefined) => execFileSync(process.execPath, [new URL('./shots/template-forge.mjs', import.meta.url).pathname, ...args], { cwd: directory, env: { ...process.env, HD_TEMPLATE_FORGE: state }, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] })
  assert.equal(run(['api', 'user']).trim(), 'demo-person')
  assert.throws(() => run(['pr', 'merge', '41']), /no scripted answer/)
  assert.throws(() => run(['pr', 'view']), /no pull requests found/)
  const head = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  assert.equal(run(['pr', 'create', '--title', 'Retry checkout', '--body', 'Handle transient responses.']).trim(), 'https://github.com/acme/storefront/pull/41')
  const observed = JSON.parse(run(['pr', 'view', '41']))
  assert.equal(observed.headRefOid, head)
  assert.equal(observed.headRefName, 'main')
  const forge = new GhFindingForge({ run: async (args, input) => ({ stdout: run(args, input ?? undefined), stderr: '', exitCode: 0, timedOut: false, overflow: false }) })
  const key = publicationKey('template-run', 2, 'review', 'template-review')
  const body = `${markerOf(key)}\n**Review** · approve\n\nScripted reviewer reviewed ${head.slice(0, 12)} in round 2 and raised no findings.`
  const operation = { key, repo: 'acme/storefront', pr: 41, project: directory, at: head,
    marker: markerOf(key), digest: sha256(body), placement: 'general' }
  const location = await forge.send(operation, body, null)
  assert.equal(location.url, 'https://github.com/acme/storefront/pull/41#issuecomment-72')
  assert.deepEqual(await forge.find(operation), [location], 'the actual publication adapter can read back the same manual-run review comment')
  assert.throws(() => run(['api', '--method', 'POST', 'repos/acme/storefront/issues/42/comments', '--input', '-'], JSON.stringify({ body })), /no scripted answer/)
})

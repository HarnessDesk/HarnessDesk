import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import * as templateRig from './shots/template-rig.mjs'
import { GhFindingForge } from '../packages/server/dist/src/findings/forge.js'
import { markerOf, publicationKey, sha256 } from '../packages/server/dist/src/findings/publication.js'

const { createTemplateRig, TEMPLATE_TASK, TEMPLATE_PUBLISH_BRANCH } = templateRig

test('contest journey cases select one check mode while retaining the complete manual journey', () => {
  assert.equal(typeof templateRig.templateJourneyCases, 'function')
  for (const mode of ['skipped', 'declared']) {
    assert.deepEqual(templateRig.templateJourneyCases(['--contest', '--contest-mode', mode]), [['mechanical-contest', mode]])
  }
  assert.deepEqual(templateRig.templateJourneyCases(['--contest']), [['mechanical-contest', 'skipped'], ['mechanical-contest', 'declared']])
  assert.deepEqual(templateRig.templateJourneyCases([]), [['comparison', 'edited'], ['fix-and-review', 'none']])
})

test('contest journey cases refuse missing, unknown, repeated or unrelated mode selectors', () => {
  assert.equal(typeof templateRig.templateJourneyCases, 'function')
  for (const args of [
    ['--contest', '--contest-mode'],
    ['--contest', '--contest-mode', 'other'],
    ['--contest', '--contest-mode', 'skipped', '--contest-mode', 'declared'],
    ['--contest-mode', 'skipped'],
  ]) assert.throws(() => templateRig.templateJourneyCases(args), /contest-mode/)
})

test('template journeys assert the persistent New Team and its explicit dry run before a real start', () => {
  const source = readFileSync(new URL('./shots/templates.mjs', import.meta.url), 'utf8')
  const start = source.indexOf("      await page.getByRole('menuitem', { name: /^New Team/ }).click()")
  const journey = source.slice(start, source.indexOf('      const run =', start))
  assert.match(journey, /const newTeam = page\.getByRole\('dialog', \{ name: 'New Team', exact: true \}\)/)
  assert.match(journey, /newTeam\.getByRole\('button', \{ name: 'Dry run', exact: true \}\)\.click\(\)/)
  assert.match(journey, /getByRole\('region', \{ name: 'Dry run', exact: true \}\)/)
  assert.match(journey, /newTeam\.getByRole\('button', \{ name: 'Start Team', exact: true \}\)\.click\(\)/)
  assert.match(journey, /expect\(newTeam\)\.toHaveCount\(0, \{ timeout: 30000 \}\)/)
  assert.doesNotMatch(journey, /name: 'Start', exact: true|name, exact: true \}\)\)\.toHaveCount/)
  const search = journey.indexOf("await newTeam.getByRole('searchbox', { name: 'Search Flows', exact: true }).fill(name)")
  const choose = journey.indexOf("await newTeam.getByRole('button', { name, exact: true }).click()")
  assert.ok(search >= 0 && choose > search, 'template selection searches the full catalogue before choosing a card outside the quick choices')
  assert.doesNotMatch(journey, /newTeam\.getByRole\('button', \{ name: \/\^Runtime for /, 'runtime pickers are reached through Configure, not searched while folded')
  const configure = journey.indexOf('await configurePrimary.click()')
  const model = journey.indexOf('await expect(primaryConfiguration.getByRole')
  assert.ok(configure >= 0 && model > configure, 'the actual role configuration is opened before runtime/model inspection')
  const completion = journey.indexOf("await completion.getByRole('button', { name: 'Completion and dry run', exact: true }).click()")
  const dryRun = journey.indexOf("await newTeam.getByRole('button', { name: 'Dry run', exact: true }).click()")
  assert.ok(completion >= 0 && dryRun > completion, 'the completion disclosure opens before pressing Dry run')
})

test('the template rig restores only a legacy project record and keeps all transport local', { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-template-test-'))
  const phases = []
  const rig = await createTemplateRig({ home: join(directory, 'home'), work: join(directory, 'work'), template: 'fix-and-review', phase: name => phases.push(name) })
  t.after(async () => { await rig.dispose(); rmSync(directory, { recursive: true, force: true }); assert.ok(phases.includes('host-dispose:begin') && phases.includes('host-dispose:end')) })
  assert.ok(phases.includes('seed:begin') && phases.includes('seed:end') && phases.includes('host-start:begin') && phases.includes('host-start:end'))
  const project = JSON.parse(readFileSync(rig.stateFile, 'utf8')).workspaces[0]
  assert.deepEqual(Object.keys(project).sort(), ['id', 'lastOpenedAt', 'name', 'path'])
  assert.equal(project.path, rig.repo)
  assert.equal(rig.git('remote', 'get-url', 'origin'), join(directory, 'home', 'storefront.git'))
  assert.equal(rig.git('branch', '--show-current'), TEMPLATE_PUBLISH_BRANCH, 'publication starts on an existing feature branch')
  const runtimes = (await rig.host.call('host/hello', {})).runtimes
  assert.deepEqual(runtimes.map(one => one.provider).sort(), ['scripted-reviewer', 'scripted-writer'])
  assert.deepEqual(runtimes.map(one => one.presentation.name).sort(), ['Scripted reviewer', 'Scripted writer'])
  const publisher = runtimes.find(one => one.provider === 'scripted-writer')
  assert.equal(publisher.ceilings.publish, undefined, 'the writer has no invented publish control')
  assert.ok(publisher.ceilings.edit, 'the writer can enforce the shipped edit step')
  assert.equal(runtimes.find(one => one.provider === 'scripted-reviewer').ceilings.publish, undefined, 'the reviewer cannot publish')
  assert.deepEqual(rig.errors, [])
  writeFileSync(join(rig.repo, 'rig-attempt.txt'), 'Attempt 1: retry transient responses.\n')
  rig.release('checks')
  const checked = execFileSync(process.execPath, ['.harnessdesk/rig-check.mjs'], { cwd: rig.repo, env: { TERM: 'dumb' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.match(checked, /Retry attempt passed/, 'the check does not depend on desk environment variables')
})

test('Side by side scripted attempts can declare the same file in their isolated checkouts (#1562)', { timeout: 60000 }, async t => {
  const started = performance.now()
  let current = 'setup'
  const phase = name => {
    current = name
    writeSync(2, `template-claims ${Math.round(performance.now() - started)}ms ${name}\n`)
  }
  const onAbort = () => phase(`abort:${current}`)
  t.signal.addEventListener('abort', onAbort, { once: true })
  t.after(() => t.signal.removeEventListener('abort', onAbort))
  const directory = mkdtempSync(join(tmpdir(), 'hd-template-claims-'))
  phase('rig:begin')
  const rig = await createTemplateRig({ home: join(directory, 'home'), work: join(directory, 'work'), phase })
  phase('rig:end')
  t.after(async () => { phase('cleanup:begin'); await rig.dispose(); rmSync(directory, { recursive: true, force: true }); phase('cleanup:end') })
  phase('source:begin')
  const source = await rig.host.call('flow/source', { root: rig.repo, id: 'comparison' })
  phase('source:end')
  const vars = { task: TEMPLATE_TASK }
  phase('preview:begin')
  const preview = await rig.host.call('flow/preview', { root: rig.repo, source, vars })
  phase('preview:end')
  assert.ok(preview.token, JSON.stringify(preview.problems))
  phase('start-goal:begin')
  const run = await rig.host.call('flow/start-goal', { root: rig.repo, source, vars, token: preview.token, sentence: TEMPLATE_TASK })
  phase('start-goal:end')
  const until = Date.now() + 30000
  phase('claims:begin')
  let attempts
  do {
    assert.deepEqual(rig.errors, [], 'both scripted claim_work calls succeeded')
    current = 'claims:execution'
    const execution = await rig.host.call('flow/execution', { run: run.id })
    assert.notEqual(execution.state, 'stalled', execution.reason)
    current = 'claims:goal-read'
    attempts = (await rig.host.call('goal/read', { goal: run.goal })).board.intents.filter(one => one.role === 'competitor')
    if (attempts.length === 2 && attempts.every(one => one.files.includes('rig-attempt.txt'))) break
    current = 'claims:wait'
    await new Promise(done => setTimeout(done, 50))
  } while (Date.now() < until)
  phase('claims:end')
  assert.equal(attempts.length, 2)
  assert.ok(attempts.every(one => one.state === 'claimed' && one.files.includes('rig-attempt.txt')))
  phase('checkout-read:begin')
  assert.equal(new Set((await rig.host.call('goal/read', { goal: run.goal })).members.filter(one => one.role === 'competitor').map(one => one.checkout.cwd)).size, 2)
  phase('checkout-read:end')
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

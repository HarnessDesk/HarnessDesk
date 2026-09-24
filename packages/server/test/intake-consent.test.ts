import assert from 'node:assert/strict'
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { plainCipher, type CredentialCipher } from '../src/credentials.js'
import { consentMatches, TriggerConsent, type ArmBinding } from '../src/intake/consent.js'
import { agent, reviewFlow, rig, TRIGGERS } from './fixtures/intake-consent.js'

/*
 * A declaration in a clone does nothing until a person on this machine
 * previews exactly what it would run and arms it. That consent is bound to
 * the committed file, the whole flow it opens, the forge sign-in, and which
 * clone this is — and any of them moving takes it away before work starts.
 */

const machine = (home: string): Promise<string> => readFile(join(home, 'triggers-machine.json'), 'utf8').catch(() => '')

const armed = async (r: ReturnType<typeof rig>, id = 'review'): Promise<void> => {
  const preview = await r.consent.preview(r.world.project, id)
  assert.deepEqual(preview.problems, [])
  assert.ok(preview.token)
  const view = await r.consent.arm(r.world.project, id, preview.token!)
  assert.equal(view.state, 'armed')
}

test('arm changes only after matching one-use preview', async () => {
  const r = rig()
  const preview = await r.consent.preview(r.world.project, 'review')
  assert.ok(preview.token)
  assert.equal(preview.expiresAt, r.world.now + 5 * 60_000)
  assert.equal(preview.moneyPolicy, 'observed-stop')
  assert.equal(preview.sourcePath, '.harnessdesk/triggers.yml')
  assert.deepEqual(preview.flow?.commands.map((one) => one.run), ['pnpm test'])
  assert.equal(preview.flow?.token, null, 'the flow part of an arm preview never carries a person start token')
  // Nothing is written by a preview.
  assert.equal(await machine(r.home), '')

  const view = await r.consent.arm(r.world.project, 'review', preview.token!)
  assert.equal(view.state, 'armed')
  assert.equal(view.armed, true)
  assert.equal(r.world.baselines, 1)
  const after = await machine(r.home)
  assert.ok(after.length > 0)
  assert.ok(await r.consent.binding(r.world.project, 'review'))

  // Replayed: refused, nothing written.
  await assert.rejects(r.consent.arm(r.world.project, 'review', preview.token!), /Preview it again/)
  // Expired.
  const late = await r.consent.preview(r.world.project, 'nightly')
  r.world.now += 5 * 60_000 + 1
  await assert.rejects(r.consent.arm(r.world.project, 'nightly', late.token!), /Preview it again/)
  // For another trigger than the one previewed.
  const other = await r.consent.preview(r.world.project, 'nightly')
  await assert.rejects(r.consent.arm(r.world.project, 'review', other.token!), /Preview it again/)
  // The file changed between preview and arm — even only a comment.
  const moved = await r.consent.preview(r.world.project, 'nightly')
  r.world.text = `${TRIGGERS}# a comment\n`
  await assert.rejects(r.consent.arm(r.world.project, 'nightly', moved.token!), /changed since/)
  r.world.text = TRIGGERS
  // The first observation fails: the switch stays off.
  const failing = await r.consent.preview(r.world.project, 'nightly')
  r.world.baselineFails = true
  await assert.rejects(r.consent.arm(r.world.project, 'nightly', failing.token!), /could not be read/)
  r.world.baselineFails = false
  // The file moves while the first observation is in flight: the queued write reads again and refuses.
  const racing = await r.consent.preview(r.world.project, 'nightly')
  r.world.duringBaseline = () => { r.world.text = `${TRIGGERS}# moved during the baseline\n` }
  await assert.rejects(r.consent.arm(r.world.project, 'nightly', racing.token!), /changed since/)
  r.world.duringBaseline = null
  r.world.text = TRIGGERS
  assert.equal(await machine(r.home), after, 'no refused arm wrote anything')
  assert.equal((await r.consent.list(r.world.project)).triggers.find((one) => one.id === 'nightly')?.state, 'off')

  // A preview that would refuse carries no token: a fork trigger over a plan that runs commands.
  const forks = await r.consent.preview(r.world.project, 'forks')
  assert.equal(forks.token, null)
  assert.match(forks.problems.map((one) => one.text).join('\n'), /only read/)
  // So does a pull-request trigger with nobody signed in to the forge.
  r.world.account = null
  const unsigned = await r.consent.preview(r.world.project, 'review')
  assert.equal(unsigned.token, null)
  assert.deepEqual(unsigned.problems.map((one) => one.fix), ['Sign in to the forge.'])
  r.world.account = 'account-digest-1'

  // Disarming turns it off, explicitly and durably.
  const off = await r.consent.disarm(r.world.project, 'review')
  assert.equal(off.state, 'off')
  assert.equal(await r.consent.binding(r.world.project, 'review'), null)
  // Nothing a person-facing read returns carries the account, a signature or the key.
  const list = JSON.stringify(await r.consent.list(r.world.project))
  const shown = JSON.stringify(await r.consent.preview(r.world.project, 'review'))
  const key = await readFile(join(r.home, 'triggers-key.bin'), 'utf8')
  for (const text of [list, shown]) {
    assert.ok(!text.includes('account-digest-1'))
    assert.ok(!text.includes(key.trim()))
    assert.ok(!/"signature"/.test(text))
  }
})

test('every bound dependency invalidates an arm', async () => {
  const r = rig()
  await armed(r)
  await armed(r, 'nightly')
  const baseline = await r.consent.binding(r.world.project, 'review')
  assert.ok(baseline)
  const changes: readonly [string, () => void, () => void, RegExp][] = [
    ['the file', () => { r.world.text = `${TRIGGERS}# only a comment\n` }, () => { r.world.text = TRIGGERS }, /triggers file changed/],
    ['the clone', () => { r.world.incarnation = 'clone-2' }, () => { r.world.incarnation = 'clone-1' }, /project was replaced/],
    ['the account', () => { r.world.account = 'account-digest-2' }, () => { r.world.account = 'account-digest-1' }, /sign-in changed/],
    ['the repository', () => { r.world.repository = 'acme/other' }, () => { r.world.repository = 'acme/widgets' }, /repository changed/],
    ['an Agent', () => { r.world.agents = [agent('reviewer', 'reviewer-digest-2')] }, () => { r.world.agents = [agent('reviewer')] }, /flow, an Agent/],
    ['the flow', () => { r.world.flows = { 'review-pr': `${reviewFlow()}# edited\n` } }, () => { r.world.flows = { 'review-pr': reviewFlow() } }, /flow, an Agent/],
    ['a command timeout', () => { r.world.flows = { 'review-pr': reviewFlow(61) } }, () => { r.world.flows = { 'review-pr': reviewFlow() } }, /flow, an Agent/],
    ['machine seating', () => { r.world.seating = 'machine'; r.world.seats = [{ runtime: 'beta' }, { runtime: 'alpha' }] }, () => { r.world.seating = 'prefer'; r.world.seats = [{ runtime: 'alpha' }] }, /flow, an Agent/],
    ['seating order', () => { r.world.seats = [{ runtime: 'alpha' }, { runtime: 'beta' }] }, () => { r.world.seats = [{ runtime: 'alpha' }] }, /flow, an Agent/],
  ]
  for (const [what, change, restore, reason] of changes) {
    change()
    assert.equal(await r.consent.binding(r.world.project, 'review'), null, `${what}: no longer authority`)
    const view = (await r.consent.list(r.world.project)).triggers.find((one) => one.id === 'review')
    assert.equal(view?.state, 'changed', what)
    assert.match(view?.reason ?? '', reason, what)
    assert.match(view?.fix ?? '', /arm it again/, what)
    restore()
    assert.deepEqual(await r.consent.binding(r.world.project, 'review'), baseline, `${what}: restored, the same arm stands`)
  }
  // A schedule binds no forge account or repository: a sign-in change leaves it armed.
  r.world.account = 'account-digest-3'
  assert.ok(await r.consent.binding(r.world.project, 'nightly'))
  // But it binds its Agent, like any flow.
  r.world.agents = [agent('reviewer', 'reviewer-digest-3')]
  assert.equal(await r.consent.binding(r.world.project, 'nightly'), null)

  // The comparison itself: each field alone is enough to refuse.
  const saved: ArmBinding = { project: '/p', incarnation: 'i', source: 's', closure: 'c', account: 'a', repository: 'r' }
  for (const field of Object.keys(saved) as (keyof ArmBinding)[]) {
    assert.equal(consentMatches(saved, { ...saved, [field]: `${String(saved[field])}-other` }), false, field)
  }
  assert.equal(consentMatches(saved, { ...saved }), true)
  assert.equal(consentMatches(null, saved), false)
})

test('copied or corrupt consent is not authority', async () => {
  const r = rig()
  await armed(r)
  const state = async (consent: TriggerConsent = r.consent) =>
    (await consent.list(r.world.project)).triggers.find((one) => one.id === 'review')

  // Copied to another machine: its own key does not verify the signature.
  const other = rig()
  await armed(other, 'nightly')
  await copyFile(join(r.home, 'triggers-machine.json'), join(other.home, 'triggers-machine.json'))
  const copied = new TriggerConsent(other.home, plainCipher, other.port)
  assert.equal((await state(copied))?.state, 'refused')
  assert.match((await state(copied))?.fix ?? '', /arm it again/)
  assert.equal(await copied.binding(r.world.project, 'review'), null)
  // A sealed key written by a different cipher is not this machine's key either.
  const sealed: CredentialCipher = {
    protection: 'test keystore',
    encrypt: (text) => Buffer.from(`sealed:${text}`),
    decrypt: (blob) => {
      const text = blob.toString('utf8')
      if (!text.startsWith('sealed:')) throw new Error('not sealed here')
      return text.slice('sealed:'.length)
    },
  }
  const foreignKey = new TriggerConsent(r.home, sealed, r.port)
  assert.equal((await state(foreignKey))?.state, 'refused')
  assert.equal(await foreignKey.binding(r.world.project, 'review'), null)

  // An edited signature, enabled bit or definition does not verify.
  const original = await machine(r.home)
  const document = JSON.parse(original) as { arms: { enabled: boolean; definition: { concurrency: number }; signature: string }[] }
  for (const edit of [
    (arm: (typeof document.arms)[number]) => { arm.signature = `${arm.signature.slice(0, -1)}${arm.signature.endsWith('0') ? '1' : '0'}` },
    (arm: (typeof document.arms)[number]) => { arm.definition.concurrency = 32 },
    (arm: (typeof document.arms)[number]) => { arm.signature = 'not hex at all' },
  ]) {
    const copy = JSON.parse(original) as typeof document
    edit(copy.arms[0]!)
    await writeFile(join(r.home, 'triggers-machine.json'), JSON.stringify(copy))
    assert.equal((await state())?.state, 'refused')
    assert.equal(await r.consent.binding(r.world.project, 'review'), null)
  }
  // An unknown version, or a file that is not JSON.
  for (const text of [JSON.stringify({ ...JSON.parse(original), version: 2 }), '{not json', JSON.stringify({ version: 1, revision: 1, arms: 'x' })]) {
    await writeFile(join(r.home, 'triggers-machine.json'), text)
    assert.equal((await state())?.state, 'refused')
    assert.equal(await r.consent.binding(r.world.project, 'review'), null)
  }
  // The key is gone.
  await writeFile(join(r.home, 'triggers-machine.json'), original)
  assert.equal((await state())?.state, 'armed')
  await rm(join(r.home, 'triggers-key.bin'))
  assert.equal((await state())?.state, 'refused')
  assert.equal(await r.consent.binding(r.world.project, 'review'), null)

  // Rearming is the repair: a person previews and arms again on this machine.
  await writeFile(join(r.home, 'triggers-machine.json'), '{not json')
  await armed(r)
  assert.ok(await r.consent.binding(r.world.project, 'review'))
  assert.equal(await readFile(join(r.home, 'triggers-machine.json.unreadable'), 'utf8'), '{not json', 'the unreadable file is kept aside, not silently lost')
  // A replaced project and a changed sign-in are refusals with the rearm fix, too.
  r.world.incarnation = 'clone-9'
  assert.equal((await state())?.state, 'changed')
  r.world.incarnation = 'clone-1'
  r.world.account = null
  const unsigned = await state()
  assert.equal(unsigned?.state, 'refused')
  assert.equal(unsigned?.fix, 'Sign in to the forge.')
  // A sign-in that cannot be read now is no answer: the fact waits rather than being consumed (review #898).
  await assert.rejects(r.consent.binding(r.world.project, 'review'), /not signed in/)
})

test('an arm binds what runs, never whether it can run right now', async () => {
  const r = rig()
  await armed(r)
  await armed(r, 'nightly')
  const baseline = await r.consent.binding(r.world.project, 'review')
  assert.ok(baseline)
  assert.ok(r.world.unattended.length > 0 && r.world.unattended.every(Boolean), 'every seat plan is read as unattended work is seated')

  // Its runtime is down: the arm still stands, and a firing's dispatch rechecks it.
  r.world.available = false
  assert.deepEqual(await r.consent.binding(r.world.project, 'review'), baseline, 'no seat right now is not a changed arm')
  assert.deepEqual(await r.consent.binding(r.world.project, 'nightly'), await r.consent.binding(r.world.project, 'nightly'))
  const listed = (await r.consent.list(r.world.project)).triggers.find((one) => one.id === 'review')
  assert.equal(listed?.state, 'armed', 'the list does not call it refused or changed')
  // A new preview still says so, and arms nothing until a seat can be taken.
  const now = await r.consent.preview(r.world.project, 'review')
  assert.equal(now.token, null)
  assert.match(now.problems.map((one) => one.text).join('\n'), /No seat could be opened/)
  const closure = await r.port.closure.freeze(r.world.project, now.definition!)
  assert.equal(closure.digest, baseline.closure, 'the closure digest is the same with or without a seat')
  assert.deepEqual(closure.problems, [], 'what only the preview says binds nothing')
  r.world.available = true

  // A read that fails now is not an answer: binding throws, so the fact is kept and offered again.
  r.world.previewFails = true
  await assert.rejects(r.consent.binding(r.world.project, 'review'), /could not be asked/)
  r.world.previewFails = false
  r.world.repository = null
  await assert.rejects(r.consent.binding(r.world.project, 'review'), /No forge repository/)
  r.world.repository = 'acme/widgets'
  r.world.account = null
  await assert.rejects(r.consent.binding(r.world.project, 'review'), /not signed in/)
  assert.ok(await r.consent.binding(r.world.project, 'nightly'), 'a schedule reads no forge')
  r.world.account = 'account-digest-1'
  assert.deepEqual(await r.consent.binding(r.world.project, 'review'), baseline, 'recovered: the same arm')

  // Content still moves it: another signed-in account, or a flow that is gone.
  r.world.account = 'account-digest-2'
  assert.equal(await r.consent.binding(r.world.project, 'review'), null)
  r.world.account = 'account-digest-1'
  r.world.flows = {}
  assert.equal(await r.consent.binding(r.world.project, 'review'), null, 'a flow that is gone is a changed arm')
  r.world.flows = { 'review-pr': reviewFlow() }
  assert.deepEqual(await r.consent.binding(r.world.project, 'review'), baseline)
})

test('changing a trigger’s label takes its arm away', async () => {
  const r = rig()
  const labelled = (label: string): string => `${TRIGGERS}- id: ready
  on: issue
  events: [labelled]
  label: ${label}
  opens: { flow: review-pr }
`
  r.world.text = labelled('agent-ready')
  await armed(r, 'ready')
  const before = await r.consent.binding(r.world.project, 'ready')
  assert.ok(before)
  const preview = await r.consent.preview(r.world.project, 'ready')
  assert.deepEqual(preview.definition?.label, ['agent-ready'], 'arming shows the label it consents to')

  // Only the label changes: the arm no longer stands, and says the file changed.
  r.world.text = labelled('ready-for-agents')
  assert.equal(await r.consent.binding(r.world.project, 'ready'), null)
  const view = (await r.consent.list(r.world.project)).triggers.find((one) => one.id === 'ready')
  assert.equal(view?.state, 'changed')
  assert.match(view?.reason ?? '', /triggers file changed/)

  // The closure a label is part of changes too, so it cannot be carried under another file's digest.
  const closure = async (label: string) => {
    const text = labelled(label)
    const definition = (await import('../src/intake/definition.js')).parseTriggers(text).definitions.find((one) => one.id === 'ready')!
    return (await r.port.closure.freeze(r.world.project, definition)).digest
  }
  assert.notEqual(await closure('agent-ready'), await closure('ready-for-agents'))
  r.world.text = labelled('agent-ready')
  assert.deepEqual(await r.consent.binding(r.world.project, 'ready'), before)
})

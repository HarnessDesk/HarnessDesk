import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DeskFeatures } from '../src/features.js'
import { tempDir } from './scratch.js'

test('an interrupted disable restores the prior effective true even if launch defaults changed', async () => {
  const file = join(tempDir('hd-feature-interrupted-'), 'features.json')
  await writeFile(file, JSON.stringify({ pending: { previous: { lead: true, mobile: false }, feature: 'lead', enabled: false } }))
  const recovered = new DeskFeatures(file, { lead: false, mobile: false }, async () => {}, () => {})
  assert.equal(recovered.read().lead, true)
  assert.equal(recovered.read().problem?.kind, 'transition')
})

test('the persisted choice stays at its prior value while a stop is unfinished', async () => {
  const file = join(tempDir('hd-feature-pending-'), 'features.json')
  let finish!: () => void
  const controller = new DeskFeatures(file, { lead: true, mobile: false }, () => new Promise(resolve => { finish = resolve }), () => {})
  const stopping = controller.set('lead', false)
  while (!finish) await new Promise(resolve => setImmediate(resolve))
  const recovered = new DeskFeatures(file, { lead: false, mobile: false }, async () => {}, () => {})
  assert.equal(recovered.read().lead, true)
  finish(); await stopping
  assert.equal(JSON.parse(await readFile(file, 'utf8')).lead, false)
})

test('a final-save failure rolls the running service back and refuses success', async () => {
  const file = join(tempDir('hd-feature-final-save-'), 'features.json'), transitions: boolean[] = []
  const controller = new DeskFeatures(file, { lead: false, mobile: false }, async (_feature, enabled) => {
    transitions.push(enabled)
    if (enabled) { await rm(file, { force: true }); await mkdir(file) }
  }, () => {})
  await assert.rejects(controller.set('mobile', true))
  assert.deepEqual(transitions, [true, false])
  assert.equal(controller.read().lead, false)
  assert.equal(controller.read().mobile, false)
  assert.equal(controller.read().problem?.kind, 'transition')
})

test('a failed rollback latches a problem and refuses unrelated changes until explicit repair', async () => {
  const file = join(tempDir('hd-feature-latched-'), 'features.json'), calls: string[] = []
  const controller = new DeskFeatures(file, { lead: false, mobile: false }, async (feature, enabled) => {
    calls.push(`${feature}:${enabled}`)
    if (feature === 'mobile' && enabled) { await rm(file, { force: true }); await mkdir(file) }
    else if (feature === 'mobile') throw Error('synthetic stop failed')
  }, () => {})
  await assert.rejects(controller.set('mobile', true))
  await rm(file, { recursive: true })
  await assert.rejects(controller.set('lead', true), /repair/i)
  assert.deepEqual(calls, ['mobile:true', 'mobile:false'])
  assert.equal((controller.read() as any).problem?.kind, 'transition')
})

test('damaged preferences refuse defaults but do not prevent ordinary host construction', async () => {
  const file = join(tempDir('hd-feature-damaged-'), 'features.json')
  await writeFile(file, '{damaged')
  const controller = new DeskFeatures(file, { lead: true, mobile: true }, async () => {}, () => {})
  assert.equal(controller.read().lead, false)
  assert.equal(controller.read().mobile, false)
  assert.equal((controller.read() as any).problem?.kind, 'preferences')
  assert.equal(await readFile(file, 'utf8'), '{damaged')
})

test('a write throwing after rename leaves a separate recovery marker and requires repair after restart', async () => {
  const { atomicJson } = await import('../src/goals/store.js')
  const file = join(tempDir('hd-feature-after-rename-'), 'features.json')
  let fail = true, mobile = false
  const io = { write: async (path: string, value: unknown) => {
    await atomicJson(path, value)
    if (path === file && fail) { fail = false; throw Error('synthetic directory sync failure after rename') }
  } }
  const controller = new DeskFeatures(file, { lead: false, mobile: false }, async (feature, enabled) => { if (feature === 'mobile') mobile = enabled }, () => {}, io)
  await assert.rejects(controller.set('mobile', true))
  assert.equal(mobile, false, 'running service was rolled back')
  assert.equal(JSON.parse(await readFile(file, 'utf8')).mobile, true, 'a thrown write may already have renamed its snapshot')
  const pending = await readFile(`${file}.pending`, 'utf8')
  const restarted = new DeskFeatures(file, { lead: true, mobile: true }, async () => {}, () => {})
  assert.equal(restarted.read().mobile, false)
  assert.equal(restarted.read().problem?.kind, 'transition')
  assert.equal(restarted.choices(), null)
  await assert.rejects(controller.set('lead', true), /Repair/)
  assert.equal(await readFile(`${file}.pending`, 'utf8'), pending)
  fail = true
  await assert.rejects(controller.repair(), /could not be repaired/)
  const failedRepair = new DeskFeatures(file, { lead: true, mobile: true }, async () => {}, () => {})
  assert.equal(failedRepair.read().lead, false); assert.equal(failedRepair.read().mobile, false)
  assert.ok(failedRepair.read().problem, 'repair barrier survives even when its final snapshot was renamed')
  await assert.rejects(controller.set('lead', true), /Repair/)
  assert.deepEqual(await controller.repair(), { lead: false, mobile: false })
  assert.deepEqual(controller.choices(), { lead: false, mobile: false })
})

test('repair preserves damaged preferences and remains latched when owned work cannot stop', async () => {
  const { readdir } = await import('node:fs/promises')
  const home = tempDir('hd-feature-repair-fail-'), file = join(home, 'features.json')
  await writeFile(file, '{damaged')
  let fail = true
  const controller = new DeskFeatures(file, { lead: true, mobile: true }, async feature => { if (feature === 'lead' && fail) throw Error('synthetic owned work remains') }, () => {})
  await assert.rejects(controller.repair(), /could not be repaired/)
  assert.equal(await readFile(file, 'utf8'), '{damaged')
  const preserved = (await readdir(home)).find(name => name.startsWith('features.json.preserved-'))!
  assert.equal(await readFile(join(home, preserved), 'utf8'), '{damaged')
  assert.ok(controller.read().problem)
  await assert.rejects(controller.set('mobile', true), /Repair/)
  fail = false
  assert.deepEqual(await controller.repair(), { lead: false, mobile: false })
  assert.equal(await readFile(join(home, preserved), 'utf8'), '{damaged')
})

test('repair can preserve an unreadable intent directory and keeps its Off barrier if replacement fails', async () => {
  const { atomicJson } = await import('../src/goals/store.js')
  const { readdir } = await import('node:fs/promises')
  const home = tempDir('hd-feature-repair-intent-'), file = join(home, 'features.json')
  await writeFile(file, JSON.stringify({ lead: true, mobile: true }))
  await mkdir(`${file}.pending`)
  let fail = true
  const controller = new DeskFeatures(file, { lead: true, mobile: true }, async () => {}, () => {}, {
    write: async (path, value) => { if (path === `${file}.pending` && fail) throw Error('synthetic intent replacement failure'); await atomicJson(path, value) },
  })
  assert.equal(controller.read().problem?.kind, 'preferences')
  await assert.rejects(controller.repair())
  const restarted = new DeskFeatures(file, { lead: true, mobile: true }, async () => {}, () => {})
  assert.equal(restarted.read().lead, false); assert.equal(restarted.read().mobile, false)
  assert.ok(restarted.read().problem)
  assert.ok((await readdir(home)).some(name => name.startsWith('features.json.pending.preserved-')))
  fail = false
  assert.deepEqual(await controller.repair(), { lead: false, mobile: false })
})

test('an unreadable repair marker still permits explicit repair without losing the artifact', async () => {
  const { readdir } = await import('node:fs/promises')
  const home = tempDir('hd-feature-repair-marker-'), file = join(home, 'features.json')
  await writeFile(file, JSON.stringify({ lead: true, mobile: true }))
  await mkdir(`${file}.repair`)
  const controller = new DeskFeatures(file, { lead: true, mobile: true }, async () => {}, () => {})
  assert.ok(controller.read().problem)
  assert.deepEqual(await controller.repair(), { lead: false, mobile: false })
  assert.ok((await readdir(home)).some(name => name.startsWith('features.json.repair.preserved-')))
})


test('portable choices are withheld during a serialized transition and return after acknowledgement', async t => {
  const dir = tempDir('hd-feature-portable-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const features = new DeskFeatures(join(dir, 'features.json'), { lead: false, mobile: false }, async () => { entered(); await gate }, () => {})
  assert.deepEqual(features.choices(), {})
  const changing = features.set('mobile', true)
  try { await waiting; assert.equal(features.choices(), null) }
  finally { release(); await changing }
  assert.deepEqual(features.choices(), { mobile: true })
  await features.close()
})

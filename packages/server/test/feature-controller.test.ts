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
  assert.deepEqual(recovered.read(), { lead: true, mobile: false })
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
    if (enabled) { await rm(file); await mkdir(file) }
  }, () => {})
  await assert.rejects(controller.set('mobile', true))
  assert.deepEqual(transitions, [true, false])
  assert.deepEqual(controller.read(), { lead: false, mobile: false })
})

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as clips from './shots/clips.mjs'

test('eight website stories have readable, double-resolution content cameras and closed timelines', () => {
  assert.ok(clips.CLIP_SCENES, 'the website recorder is implemented')
  assert.deepEqual(Object.keys(clips.CLIP_SCENES), ['teams', 'run', 'race', 'browser', 'handoff', 'library', 'permissions', 'dashboard'])
  for (const scene of Object.values(clips.CLIP_SCENES)) {
    assert.ok(scene.width >= 720 && scene.width <= 960)
    assert.equal(scene.scale, 2)
    assert.ok(scene.crop)
    assert.ok(scene.duration >= 6 && scene.duration <= 9)
    assert.equal(scene.actions.at(-1).kind, 'reset')
    assert.ok(scene.actions.at(-1).at < scene.duration * 1000 - 500)
  }
  assert.ok(!JSON.stringify(clips.CLIP_SCENES.dashboard).includes('By hour'))
})

test('the capture cadence is fixed and a mismatching last frame refuses encoding', () => {
  assert.equal(typeof clips.frameTimes, 'function')
  const times = clips.frameTimes(8, 24)
  assert.equal(times.length, 192)
  assert.equal(times[0], 0)
  for (let i = 1; i < times.length; i++) assert.ok(Math.abs(times[i] - times[i - 1] - 1000 / 24) < 1e-9)
  assert.doesNotThrow(() => clips.assertLoopClosed(Buffer.from('pixels'), Buffer.from('pixels')))
  assert.throws(() => clips.assertLoopClosed(Buffer.from('first'), Buffer.from('last')), /loop/i)
})

test('encoded artifacts refuse excessive width, bytes, wrong codec, format, duration or audio', () => {
  assert.equal(typeof clips.assertClipLimits, 'function')
  const good = { width: 1600, bytes: 1_400_000, duration: 8, codec: 'h264', pixelFormat: 'yuv420p', audio: false }
  assert.doesNotThrow(() => clips.assertClipLimits(good, 8))
  for (const patch of [{ width: 1602 }, { bytes: 1_500_001 }, { duration: 7 }, { codec: 'vp9' }, { pixelFormat: 'yuv444p' }, { audio: true }]) {
    assert.throws(() => clips.assertClipLimits({ ...good, ...patch }, 8), /clip/i)
  }
})

test('a real target must be inside the fixed camera before the pointer can act', () => {
  assert.equal(typeof clips.assertTargetInCamera, 'function')
  const camera = { x: 20, y: 30, width: 800, height: 600 }
  assert.doesNotThrow(() => clips.assertTargetInCamera(camera, { x: 40, y: 40, width: 50, height: 30 }))
  assert.throws(() => clips.assertTargetInCamera(camera, { x: 40, y: -100, width: 50, height: 30 }), /camera/)
  assert.throws(() => clips.assertTargetInCamera(camera, { x: 900, y: 40, width: 50, height: 30 }), /camera/)
})

test('clips and posters never replace a referenced destination, including symlink aliases', t => {
  assert.equal(typeof clips.assertClipDestination, 'function')
  const root = mkdtempSync(join(tmpdir(), 'hd-clips-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const assets = join(root, 'docs/images/site')
  mkdirSync(assets, { recursive: true })
  for (const ext of ['mp4', 'webp', 'jpg']) writeFileSync(join(assets, `run-light.${ext}`), 'existing')
  writeFileSync(join(root, 'README.md'), '<video src="docs/images/site/run-light.mp4" poster="docs/images/site/run-light.webp">')
  writeFileSync(join(root, 'docs/guide.md'), '<img src="images/site/run-light.jpg">')
  symlinkSync(assets, join(root, 'alias'), 'dir')
  for (const ext of ['mp4', 'webp', 'jpg']) {
    assert.throws(() => clips.assertClipDestination(root, join(assets, `run-light.${ext}`)), /referenced/)
    assert.throws(() => clips.assertClipDestination(root, join(root, `alias/run-light.${ext}`)), /referenced/)
    assert.doesNotThrow(() => clips.assertClipDestination(root, join(root, `scratch/run-light.${ext}`)))
  }
  for (const [name, reference] of [
    ['reference.webp', '![Preview][poster]\n[poster]: docs/images/site/reference.webp'],
    ['angle.webp', '![Preview](<docs/images/site/angle.webp>)'],
    ['root.webp', '<img src="/docs/images/site/root.webp">'],
  ]) {
    writeFileSync(join(assets, name), 'existing')
    writeFileSync(join(root, 'README.md'), reference)
    assert.throws(() => clips.assertClipDestination(root, join(assets, name)), /referenced/, reference)
  }
})

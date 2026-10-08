import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertReplaceable, auditSnapshots } from './shots/stills.mjs'

test('new stills cannot replace a referenced asset, including relative doc references', t => {
  const root = mkdtempSync(join(tmpdir(), 'hd-stills-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'docs', 'images', 'app'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '<img src="docs/images/app/hero-light.png">')
  writeFileSync(join(root, 'docs', 'guide.md'), '<img src="images/app/race-tiles-dark.png">')
  writeFileSync(join(root, 'docs', 'images', 'app', 'hero-light.png'), '')
  writeFileSync(join(root, 'docs', 'images', 'app', 'race-tiles-dark.png'), '')
  assert.throws(() => assertReplaceable(root, 'hero-light.png'), /referenced/)
  assert.throws(() => assertReplaceable(root, 'race-tiles-dark.png'), /referenced/)
  const scratch = join(root, 'scratch')
  mkdirSync(scratch)
  writeFileSync(join(scratch, 'hero-light.png'), '')
  assert.doesNotThrow(() => assertReplaceable(root, 'hero-light.png', scratch))
  assert.throws(() => assertReplaceable(root, 'hero-light.png', join(root, 'docs/images/app/../app')), /referenced/)
  symlinkSync(join(root, 'docs/images/app'), join(root, 'asset-alias'), 'dir')
  assert.throws(() => assertReplaceable(root, 'hero-light.png', join(root, 'asset-alias')), /referenced/)
  assert.doesNotThrow(() => assertReplaceable(root, 'run-timeline-light.png'))
  writeFileSync(join(root, 'docs', 'flows.md'), '<img src="images/app/flow-light.png">')
  writeFileSync(join(root, 'docs', 'images', 'app', 'flow-light.png'), '')
  assert.doesNotThrow(() => assertReplaceable(root, 'flow-light.png'))
})

test('every embedded browser document is audited before its parent frame can be captured', () => {
  const clean = { text: 'Jane Doe · dev@example.com · Picked', documentTitle: 'Preview', attributes: [] }
  assert.doesNotThrow(() => auditSnapshots([clean, { ...clean, text: 'Storefront · Order confirmed' }]))
  // Fictional rejection inputs, following shots-audit.test.mjs; never camera fixtures.
  assert.throws(() => auditSnapshots([clean, { ...clean, text: 'person@private.invalid' }]), /Unpublishable/) // hd-secrets-ok
  assert.throws(() => auditSnapshots([{ ...clean, attributes: [['title', '/Users/private/work/project']] }]), /Unpublishable/) // hd-secrets-ok
})

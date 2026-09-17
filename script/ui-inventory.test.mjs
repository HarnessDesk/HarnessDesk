import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildInventory, classifyUiFile } from './ui-inventory.mjs'

test('ledger check rejects an edited output and regenerates from separate reviewed input', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-inventory-output-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const dir of ['script/lib', 'docs', 'packages/ui/src/components']) fs.mkdirSync(path.join(root, dir), { recursive: true })
  for (const rel of ['ui-inventory.mjs', 'lib/repository-files.mjs']) fs.copyFileSync(fileURLToPath(new URL(rel, import.meta.url)), path.join(root, 'script', rel))
  const panel = 'packages/ui/src/components/Panel.tsx'
  fs.writeFileSync(path.join(root, panel), 'export const Panel = () => <div />')
  fs.writeFileSync(path.join(root, 'script/ui-inventory-dispositions.json'), JSON.stringify({ version: 1, dispositions: {
    [panel]: { owner: 'feature-composition', disposition: 'migrated', evidence: 'explicit review' },
  } }))
  execFileSync('git', ['init', '-q', root])
  execFileSync('git', ['add', panel], { cwd: root })
  const run = (args = []) => spawnSync(process.execPath, ['script/ui-inventory.mjs', ...args], { cwd: root, encoding: 'utf8' })
  assert.equal(run().status, 0)
  assert.equal(run(['--check']).status, 0)
  const output = path.join(root, 'docs/ui-system-migration-ledger.json')
  const ledger = JSON.parse(fs.readFileSync(output, 'utf8'))
  ledger.entries[0].owner = 'invented owner'
  fs.writeFileSync(output, `${JSON.stringify(ledger, null, 2)}\n`)
  assert.equal(run(['--check']).status, 1)
  assert.equal(run().status, 0)
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).entries[0].owner, 'feature-composition')
})

test('fresh nonproduction classification cannot be overwritten by a prior ledger entry', () => {
  assert.throws(() => buildInventory({
    files: ['packages/ui/src/components/Panel.test.tsx'],
    read: () => '<div />',
    overrides: { 'packages/ui/src/components/Panel.test.tsx': { scope: 'production', owner: 'invented', disposition: 'migrated', evidence: 'invented' } },
  }), /classification|disposition/)
})

test('explicit production dispositions cannot disguise production as a test boundary', () => {
  assert.throws(() => buildInventory({
    files: ['packages/ui/src/components/Panel.tsx'],
    read: () => '<div />',
    overrides: { 'packages/ui/src/components/Panel.tsx': { scope: 'test', owner: 'verification', disposition: 'verified-boundary', evidence: 'invented' } },
  }), /classification|disposition/)
})

for (const scope of ['', null, false, 0, undefined]) {
  test(`rejects the present invalid production scope ${String(scope)}`, () => {
    assert.throws(() => buildInventory({
      files: ['packages/ui/src/components/Panel.tsx'],
      read: () => '<div />',
      overrides: { 'packages/ui/src/components/Panel.tsx': {
        scope, owner: 'feature-composition', disposition: 'migrated', evidence: 'explicit review',
      } },
    }), /classification|disposition/)
  })
}

test('requires an explicit ledger disposition for every production file', () => {
  assert.deepEqual(classifyUiFile('packages/ui/src/design/ui/button.tsx'), {
    scope: 'production',
    owner: 'unclassified',
    disposition: 'pending',
    evidence: 'new visual source requires an explicit owner and boundary',
  })
  assert.deepEqual(classifyUiFile('packages/ui/src/components/NewSurface.tsx'), {
    scope: 'production',
    owner: 'unclassified',
    disposition: 'pending',
    evidence: 'new visual source requires an explicit owner and boundary',
  })
  assert.deepEqual(classifyUiFile('packages/ui/src/components/Composer.test.tsx'), {
    scope: 'test',
    owner: 'verification',
    disposition: 'verified-boundary',
    evidence: 'covered by the repository test gates',
  })
  assert.equal(classifyUiFile('packages/desktop/electron/assets/about.html').disposition, 'pending')
  assert.deepEqual(classifyUiFile('assets/brand/svgs/harnessdesk-app-icon-dark.svg'), {
    scope: 'asset',
    owner: 'brand-asset',
    disposition: 'specialized-boundary',
    evidence: 'brand artwork through the icon facade',
  })
})

test('applies explicit per-file dispositions without directory inference', () => {
  const inventory = buildInventory({
    files: ['packages/ui/src/components/NewSurface.tsx'],
    read: () => 'export const NewSurface = () => <button>Run</button>',
    overrides: {
      'packages/ui/src/components/NewSurface.tsx': {
        scope: 'production',
        owner: 'feature-composition',
        disposition: 'migrated',
        evidence: 'uses the public design API and has a behavior test',
      },
    },
  })

  assert.deepEqual(inventory.unresolved, [])
  assert.equal(inventory.entries[0]?.owner, 'feature-composition')
})

test('discovers embedded visual templates in JavaScript without treating ordinary scripts as UI', () => {
  const inventory = buildInventory({
    files: ['packages/plugin/src/card.mjs', 'packages/server/src/ordinary.ts'],
    read: (file) =>
      file.endsWith('card.mjs')
        ? 'export const view = `<button type="button">Run</button>`'
        : 'export const answer = 42',
  })

  assert.deepEqual(inventory.entries.map((entry) => entry.path), ['packages/plugin/src/card.mjs'])
  assert.equal(inventory.startingCommit, '9f2d6dec1d8e7534c83a4c8d23d7b7d280fb3422')
})

test('reports an unclassified production file without an override', () => {
  const inventory = buildInventory({
    files: ['packages/new-surface/src/View.tsx'],
    read: () => 'export const NewSurface = () => <button>Run</button>',
  })

  assert.deepEqual(inventory.unresolved, ['packages/new-surface/src/View.tsx'])
  assert.equal(inventory.entries[0]?.owner, 'unclassified')
})

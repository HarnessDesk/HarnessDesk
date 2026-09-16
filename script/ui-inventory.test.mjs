import assert from 'node:assert/strict'
import test from 'node:test'

import { buildInventory, classifyUiFile } from './ui-inventory.mjs'

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

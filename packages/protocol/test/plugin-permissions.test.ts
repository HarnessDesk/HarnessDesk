import assert from 'node:assert/strict'
import { test } from 'node:test'

import { NO_PERMISSIONS, type PluginPermissions } from '../src/capability.js'
import { describePermissions } from '../src/plugin-permissions.js'

/**
 * The one describer the consent dialog and the Plugins page both read.
 *
 * They used to be two functions, and the one a person reads *before* granting
 * was the weaker of the two (#288): no wildcard case, and no knowledge of five
 * of the grants the manifest type allows.
 */

const FALLBACK = 'Nothing beyond running in the plugin host'

const grant = (over: Partial<PluginPermissions>): PluginPermissions => ({
  ...NO_PERMISSIONS,
  ...over,
})

test('a plugin asking to reach every host is not described as a hostname', () => {
  const lines = describePermissions(grant({ network: { hosts: ['*'] } }))

  // What the page said instead. `Reach *` reads as a typo or as a glob
  // somebody will assume is scoped; the grant is the whole network.
  assert.ok(!lines.includes('Reach *'), `a bare glyph was shown: ${lines.join(' | ')}`)
  assert.ok(lines.includes('Reach any host on the network'), lines.join(' | '))

  // The control: a scoped grant still names its host, so a describer that
  // simply stopped saying "Reach" anything could not pass the assertion above.
  assert.ok(
    describePermissions(grant({ network: { hosts: ['api.example.com'] } })).includes(
      'Reach api.example.com',
    ),
  )

  // A wildcard among named hosts is still a wildcard: the widest grant in the
  // list is the one the sentence has to carry.
  assert.ok(
    describePermissions(grant({ network: { hosts: ['api.example.com', '*'] } })).includes(
      'Reach any host on the network',
    ),
  )
})

test('several hosts are one line, because the surface renders one row per line', () => {
  /* The shape question. Each line becomes a `Row` on the Plugins page, and a
     row is ~58px of card whether it holds a sentence or a hostname — so one
     row per host makes a plugin's whole Access list a column of near-identical
     "Reach …" rows that pushes the grants that cost something off the card.
     `Kit.module.css .rowTitle` sets no `white-space` and no `text-overflow`,
     so the joined line wraps inside its own row and arrives whole. */
  const lines = describePermissions(
    grant({ network: { hosts: ['api.example.com', 'logs.example.com', 'cdn.example.com'] } }),
  )
  const reach = lines.filter((line) => line.startsWith('Reach '))
  assert.equal(reach.length, 1, `hosts became ${reach.length} rows: ${reach.join(' | ')}`)
  assert.equal(reach[0], 'Reach api.example.com, logs.example.com, cdn.example.com')
})

/**
 * Every grant the type allows, one at a time.
 *
 * Keyed by `keyof PluginPermissions`, so adding a permission to the type
 * without adding it here does not compile — which is the only version of this
 * test that keeps working. The renderer's copy handled eight of these twelve,
 * and the four it missed were not obscure: `browser`, `ios` and `android` are
 * each the *only* grant a shipped built-in declares, so those three plugins
 * described themselves to the person as asking for nothing at all.
 */
const EVERY_GRANT: Record<keyof PluginPermissions, PluginPermissions> = {
  workspace: grant({ workspace: { read: true, write: true } }),
  shell: grant({ shell: true }),
  network: grant({ network: { hosts: ['api.example.com'] } }),
  agents: grant({ agents: { invoke: true } }),
  ui: grant({ ui: { contribute: true } }),
  browser: grant({ browser: true }),
  ios: grant({ ios: true }),
  android: grant({ android: true }),
  editor: grant({ editor: true }),
  team: grant({ team: true }),
  forge: grant({ forge: true }),
  secrets: grant({ secrets: ['deploy-token'] }),
}

test('no grant the manifest type allows goes undescribed', () => {
  for (const [name, permissions] of Object.entries(EVERY_GRANT)) {
    const lines = describePermissions(permissions)
    assert.notDeepEqual(
      lines,
      [FALLBACK],
      `"${name}" is grantable and describes itself as nothing`,
    )
    assert.ok(lines.length > 0)
  }

  // Both halves of the workspace grant are their own sentence: "read" and
  // "read and write" are different things to agree to.
  assert.deepEqual(describePermissions(grant({ workspace: { read: true, write: false } })), [
    'Read files in the open project',
  ])
  assert.ok(
    describePermissions(grant({ workspace: { read: true, write: true } })).includes(
      'Change files in the open project',
    ),
  )

  // The control: the fallback is reachable, so the assertion above is a
  // statement about these grants and not one the describer can never fail.
  assert.deepEqual(describePermissions(NO_PERMISSIONS), [FALLBACK])
})

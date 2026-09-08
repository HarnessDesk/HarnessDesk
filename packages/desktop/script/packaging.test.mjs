import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { TEMPLATE_BRIDGES } from '@harnessdesk/server'

/**
 * The packaged app's half of the template catalogue.
 *
 * `bridgeEntryOf()` finds a bridge as a sibling of the server package — in the
 * built app, `node_modules/@harnessdesk/<bridge>` — and a spawned Node child
 * cannot execute from inside an asar archive. So every bridge template needs
 * two things from this package.json: the bridge in the dependency graph, or
 * electron-builder never packs it at all, and an `asarUnpack` rule that turns
 * the archive entry back into real files.
 *
 * Nothing in a dev run exercises either condition — the workspace serves the
 * bridges as ordinary files — which is how a build shipped where Add agent
 * showed "This build of HarnessDesk does not carry the Claude Code bridge"
 * while every dev launch was green. This test is where the packaged layout is
 * pinned; `smoke-packaged.mjs` checks the built artifact itself.
 */

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('every template bridge is a dependency of the app', () => {
  const dependencies = Object.keys(manifest.dependencies ?? {})
  for (const bridge of TEMPLATE_BRIDGES) {
    assert.ok(
      dependencies.includes(`@harnessdesk/${bridge}`),
      `@harnessdesk/${bridge} must be a dependency of @harnessdesk/desktop: ` +
        `electron-builder packs only the dependency graph, so without it the ` +
        `packaged catalogue reports the ${bridge} template as unavailable.`,
    )
  }
})

test('node_modules is unpacked wholesale, so spawned children are real files', () => {
  assert.ok(
    manifest.build.asarUnpack.includes('**/node_modules/**'),
    'asarUnpack must carry **/node_modules/** — the bridges and mcp-tools are ' +
      'spawned as Node child processes, which cannot execute from inside ' +
      'app.asar, and claude-acp alone pulls ~100 transitive packages, so ' +
      'per-package globs would rot the first time a dependency moved.',
  )
})

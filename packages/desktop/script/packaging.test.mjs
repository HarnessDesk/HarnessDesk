import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { matchesGlob } from 'node:path'
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
const smoke = readFileSync(new URL('./smoke-packaged.mjs', import.meta.url), 'utf8')

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

test('mcp-tools is a dependency of the app', () => {
  const dependencies = Object.keys(manifest.dependencies ?? {})
  assert.ok(
    dependencies.includes('@harnessdesk/mcp-tools'),
    '@harnessdesk/mcp-tools must be a dependency of @harnessdesk/desktop: ' +
      'electron-builder packs only the dependency graph, and toolBridgeEntry ' +
      'resolves mcp-tools/dist/src/main.js to spawn as the agent tool bridge.',
  )
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

test('the packaged smoke never opens the developer keychain', () => {
  assert.match(
    smoke,
    /['"]--use-mock-keychain['"]/,
    'the ad-hoc bundle gets a new Keychain identity on each build; the smoke ' +
      'must use Chromium\'s isolated mock keychain or app.ready can wait behind ' +
      'an OS prompt before the renderer and catalogue exist.',
  )
})

test('the packaged smoke awaits forced exit before removing isolated state', () => {
  assert.match(smoke, /child\.kill\('SIGKILL'\)\s*\n\s*await waitForExit\(3000\)/)
  assert.match(smoke, /maxRetries:\s*10/)
})

test('the built-in Agents are named in the server package manifest', () => {
  const server = JSON.parse(readFileSync(new URL('../../server/package.json', import.meta.url), 'utf8'))
  assert.ok(
    (server.files ?? []).includes('agents'),
    '@harnessdesk/server should list "agents" in its files, so the manifest says what the package holds. ' +
      'That alone is not why a packaged app carries the folder — the desktop build copies this whole ' +
      'workspace package regardless of "files", and unpacks it with asarUnpack; the two tests below pin ' +
      'the mechanism that actually ships it.',
  )
  assert.match(smoke, /agent\/list/, 'the packaged smoke asks the built app for its Agents')
})

/**
 * A file the desktop build must actually carry, unpacked, for the app to list even one built-in Agent:
 * the brief of the Agent every fixture and screenshot rig starts as.
 */
const AN_AGENT_FILE = 'node_modules/@harnessdesk/server/agents/code-reviewer/AGENT.md'

test('asarUnpack really covers the folder the Agents ship in', () => {
  const unpack = manifest.build.asarUnpack ?? []
  assert.ok(
    unpack.some((glob) => matchesGlob(AN_AGENT_FILE, glob)),
    `packages/desktop/package.json's build.asarUnpack must cover ${AN_AGENT_FILE}: the server package is ` +
      'copied into node_modules whole, but electron-builder still seals it inside app.asar unless asarUnpack ' +
      'pulls it back out, and neither a spawned Node child nor a person browsing the built app can read a ' +
      'path inside app.asar.',
  )
})

/**
 * The folders that brief sits in, down from the one every Agent shares. electron-builder filters folders as
 * well as files, and never descends into one its filter rejects — so a negated glob that names a folder, the
 * Agents' own for one, drops every brief beneath it without matching a single file.
 */
const AGENT_FOLDERS = [
  'node_modules/@harnessdesk/server/agents',
  'node_modules/@harnessdesk/server/agents/code-reviewer',
]

test('no negated build.files glob excludes an Agent brief, or a folder it ships in, from the packaged app', () => {
  const negated = (manifest.build.files ?? []).filter((glob) => glob.startsWith('!'))
  const excluding = negated.filter((glob) =>
    [...AGENT_FOLDERS, AN_AGENT_FILE].some((path) => matchesGlob(path, glob.slice(1))),
  )
  assert.deepEqual(
    excluding,
    [],
    `packages/desktop/package.json's build.files must not exclude ${AN_AGENT_FILE}, or a folder it sits in: ` +
      'a negated glob broad enough to catch either (for example "!**/*.md", or "!**/agents", since ' +
      'electron-builder never descends into a folder its filter rejects) drops every shipped Agent brief ' +
      'from the packaged app, whatever asarUnpack says about the folder around them.',
  )
})

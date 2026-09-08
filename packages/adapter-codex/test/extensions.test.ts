import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CodexRuntime } from '../src/index.js'

/**
 * Codex's extension plane, flattened. The catalogue merges plugins and apps,
 * carries a marketplace's load error rather than hiding it, and install and
 * uninstall move a plugin's state. MCP servers report their tool counts and
 * auth.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

const start = async (t: { after(fn: () => Promise<void>): void }): Promise<CodexRuntime> => {
  const runtime = new CodexRuntime({ binaryPath: FAKE, clientName: 'harnessdesk-test' })
  t.after(() => runtime.dispose())
  await runtime.start()
  return runtime
}

test('the catalogue is the curated plugins, with load errors kept and apps excluded', async (t) => {
  const runtime = await start(t)
  const catalog = await runtime.extensions.catalog('/w')
  const documents = catalog.plugins.find((plugin) => plugin.id === 'documents@openai-curated')
  assert.equal(documents?.name, 'Documents')
  assert.equal(documents?.category, 'Productivity')
  assert.deepEqual(documents?.screenshotUrls, ['https://x/1.png'])
  // The app/connector directory is thousands of entries and is not listed here.
  assert.ok(!catalog.plugins.some((plugin) => plugin.external))
  assert.deepEqual(catalog.marketplaces, ['openai-curated'])
  assert.equal(catalog.loadErrors[0]?.message, 'could not parse')
  assert.deepEqual(catalog.featured, ['documents@openai-curated'])
})

test('a plugin logo is inlined from the installed package, and a catalogue URL is dropped', async (t) => {
  const runtime = await start(t)
  const catalog = await runtime.extensions.catalog('/w')
  assert.match(
    catalog.plugins.find((plugin) => plugin.id === 'documents@openai-curated')?.logoUrl ?? '',
    /^data:image\/svg\+xml;base64,/,
    'an installed plugin’s own logo file travels as a data URI',
  )
  assert.equal(
    catalog.plugins.find((plugin) => plugin.id === 'spreadsheets@openai-curated')?.logoUrl,
    null,
    'a catalogue entry’s remote logoUrl is not carried: the renderer allows ' +
      '`img-src \'self\' data: blob:`, so it could only fail into the fallback',
  )
})

test('apps are searched, not listed, and come back marked external with a link out', async (t) => {
  const runtime = await start(t)
  const { apps } = await runtime.extensions.searchApps('github')
  const github = apps.find((app) => app.id === 'github')
  assert.equal(github?.external, true)
  assert.equal(github?.installUrl, 'https://chatgpt.com/apps/github')
  assert.equal(github?.logoUrl, undefined, 'a directory listing has only a remote logo, so it carries none')
  const none = await runtime.extensions.searchApps('nothingmatchesthis')
  assert.deepEqual(none.apps, [])
})

test('installing and uninstalling move a plugin between states', async (t) => {
  const runtime = await start(t)
  const before = (await runtime.extensions.catalog()).plugins.find((p) => p.id === 'spreadsheets@openai-curated')
  assert.equal(before?.installed, false)
  await runtime.extensions.install('openai-curated', 'spreadsheets')
  const after = (await runtime.extensions.catalog()).plugins.find((p) => p.id === 'spreadsheets@openai-curated')
  assert.equal(after?.installed, true)
  await runtime.extensions.uninstall('spreadsheets@openai-curated')
  const gone = (await runtime.extensions.catalog()).plugins.find((p) => p.id === 'spreadsheets@openai-curated')
  assert.equal(gone?.installed, false)
})

test('MCP servers report tools, resources and auth, and login returns a URL', async (t) => {
  const runtime = await start(t)
  const servers = await runtime.extensions.mcpServers('/w')
  assert.deepEqual(
    servers.map((server) => [server.name, server.tools.length, server.auth]),
    [
      ['github', 2, 'token'],
      ['figma', 0, 'needsLogin'],
      ['local-tools', 3, 'none'],
    ],
  )
  assert.equal(await runtime.extensions.mcpLogin('figma'), 'https://auth.example/mcp/figma')
  await runtime.extensions.reloadMcp()
})

test('importable configs are detected, and applying them clears the offer', async (t) => {
  const runtime = await start(t)
  const items = await runtime.extensions.detectImports('/w')
  // Configuration, never conversations: Codex offers to copy another agent's
  // transcripts in as its own threads, which would put one conversation in
  // two lists under two names. Hand off is how work crosses agents.
  assert.deepEqual(
    items.map((item) => item.kind),
    ['MCP_SERVER_CONFIG', 'SKILLS'],
  )
  await runtime.extensions.importConfigs(items)
  assert.deepEqual(await runtime.extensions.detectImports('/w'), [], 'nothing left to import after applying')
})

test('a conversation import is refused even when asked for directly', async (t) => {
  const runtime = await start(t)
  await assert.rejects(
    runtime.extensions.importConfigs([
      { kind: 'SESSIONS', label: 'Migrate 58 sessions from Claude Code', token: {} },
    ]),
    /not imported between agents/,
  )
})

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  ExtensionKernel,
  ManifestError,
  describePermissions,
  install,
  inspect,
  listInstalled,
  loadInstalled,
  parseManifest,
  readPermissions,
  uninstall,
} from '../src/index.js'

/**
 * Installing plugins from outside the repository.
 *
 * The fixture is a real directory with a real manifest and a real ES module, so
 * these exercise the path a third-party plugin actually takes: read the manifest,
 * show what it asks for, copy it in, import it, hold it to its manifest.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/sample-plugin', import.meta.url))
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

/** Points the installer at a scratch plugins directory for the duration of a test. */
const withPluginsRoot = async (
  t: { after: (fn: () => unknown) => void },
): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-plugins-'))
  const previous = process.env['HARNESSDESK_PLUGINS']
  process.env['HARNESSDESK_PLUGINS'] = dir
  t.after(async () => {
    if (previous === undefined) delete process.env['HARNESSDESK_PLUGINS']
    else process.env['HARNESSDESK_PLUGINS'] = previous
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

// -------------------------------------------------------------- manifest

test('a well-formed manifest parses', () => {
  const pkg = parseManifest(
    { id: 'demo', name: 'Demo', main: './main.js', permissions: { shell: true } },
    { path: '/p/harnessdesk.plugin.json', directory: '/p', source: { kind: 'local', path: '/p' } },
  )
  assert.equal(pkg.manifest.id, 'demo')
  assert.equal(pkg.entry, './main.js')
  assert.equal(pkg.manifest.permissions?.shell, true)
})

test('the id must be safe as a directory name and a tool namespace', () => {
  const at = { path: '/p/m.json', directory: '/p', source: { kind: 'local' as const, path: '/p' } }
  for (const id of ['../escape', 'Has Spaces', 'UPPER', '', '-leading', 'a'.repeat(80)]) {
    assert.throws(() => parseManifest({ id, name: 'x' }, at), ManifestError, `accepted ${id}`)
  }
  assert.doesNotThrow(() => parseManifest({ id: 'good-one-2', name: 'x' }, at))
})

test('the entry point cannot escape the plugin directory', () => {
  assert.throws(
    () =>
      parseManifest(
        { id: 'demo', name: 'Demo', main: '../../etc/evil.js' },
        { path: '/p/m.json', directory: '/p', source: { kind: 'local', path: '/p' } },
      ),
    ManifestError,
  )
})

test('a malformed permissions block grants nothing', () => {
  // Being generous with a broken grant is how a permission system becomes
  // decorative.
  for (const value of [undefined, null, 'shell', 42, [], { workspace: 'yes' }]) {
    const permissions = readPermissions(value)
    assert.equal(permissions.workspace.read, false)
    assert.equal(permissions.workspace.write, false)
    assert.equal(permissions.shell, false)
    assert.deepEqual(permissions.network.hosts, [])
    assert.equal(permissions.ui.contribute, false)
  }
})

test('permissions are described in terms a person can judge', () => {
  const described = describePermissions(
    readPermissions({
      workspace: { read: true, write: true },
      shell: true,
      network: { hosts: ['api.example.com'] },
    }),
  )
  assert.ok(described.some((line) => /Read files/.test(line)))
  assert.ok(described.some((line) => /Change files/.test(line)))
  assert.ok(described.some((line) => /Run programs/.test(line)))
  assert.ok(described.some((line) => /api\.example\.com/.test(line)))

  assert.match(describePermissions(readPermissions({}))[0] ?? '', /Nothing beyond/)
  assert.ok(
    describePermissions(readPermissions({ network: { hosts: ['*'] } })).some((line) =>
      /any host/.test(line),
    ),
  )
})

// ------------------------------------------------------------- installing

test('a plugin can be inspected before any of its code is imported', async (t) => {
  await withPluginsRoot(t)
  const pkg = await inspect(FIXTURE)
  assert.equal(pkg.manifest.id, 'sample')
  assert.equal(pkg.manifest.version, '1.0.0')
  assert.deepEqual(describePermissions(pkg.manifest.permissions as never), [
    'Read files in the open project',
  ])
})

test('installing copies the plugin into HarnessDesk’s own directory', async (t) => {
  const root = await withPluginsRoot(t)
  const installed = await install(FIXTURE)

  assert.equal(installed.id, 'sample')
  assert.equal(installed.directory, join(root, 'sample'))
  // Loading in place would let the plugin change under the app whenever its
  // source directory changed.
  assert.notEqual(installed.directory, FIXTURE)
  assert.ok(await readFile(join(installed.directory, 'index.js'), 'utf8'))

  assert.deepEqual(
    (await listInstalled()).map((entry) => entry.id),
    ['sample'],
  )
})

test('an installed plugin loads, registers, and runs', async (t) => {
  await withPluginsRoot(t)
  const installed = await install(FIXTURE)
  const definition = await loadInstalled(installed.directory)

  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load({ ...definition, config: { greeting: 'Hi' } })
  await settle()

  const plugin = kernel.plugins()[0]
  assert.equal(plugin?.state.type, 'active')
  assert.equal(plugin?.identity.name, 'Sample plugin')

  const greet = kernel.list('tool').find((entry) => entry.name === 'greet')
  assert.ok(greet)
  const result = await kernel.invokeTool(greet.id, { who: 'there' }, {})
  assert.equal(result.ok && result.content[0]?.type === 'text' && result.content[0].text, 'Hi, there')
})

test('an installed plugin is held to its manifest, not to what it tries', async (t) => {
  await withPluginsRoot(t)
  const installed = await install(FIXTURE)
  const definition = await loadInstalled(installed.directory)

  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  kernel.setWorkspace({ root: installed.directory, branch: null })
  await kernel.load(definition)
  await settle()

  // The fixture asks for workspace read, then reaches for /etc/hosts anyway.
  const peek = kernel.list('tool').find((entry) => entry.name === 'peek_outside')
  const result = await kernel.invokeTool(peek!.id, {}, {})
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.error : '', /outside the open workspace/)
})

test('a plugin exporting nothing usable fails with a readable message', async (t) => {
  const root = await withPluginsRoot(t)
  const broken = join(root, '..', 'broken-src')
  await mkdir(broken, { recursive: true })
  t.after(() => rm(broken, { recursive: true, force: true }))
  await writeFile(
    join(broken, 'harnessdesk.plugin.json'),
    JSON.stringify({ id: 'broken', name: 'Broken' }),
  )
  await writeFile(join(broken, 'index.js'), 'export const somethingElse = 1\n')

  const installed = await install(broken)
  await assert.rejects(() => loadInstalled(installed.directory), /exports neither/)
})

test('a directory with no manifest is refused', async (t) => {
  const root = await withPluginsRoot(t)
  await assert.rejects(() => inspect(root), /needs one at its root/)
})

test('uninstalling removes it and refuses to escape the plugins directory', async (t) => {
  await withPluginsRoot(t)
  await install(FIXTURE)
  assert.equal((await listInstalled()).length, 1)

  await uninstall('sample')
  assert.equal((await listInstalled()).length, 0)

  await assert.rejects(() => uninstall('../../etc'), /outside the plugins directory/)
})

test('the installed copy remembers where it came from, and updates reload fresh code', async (t) => {
  await withPluginsRoot(t)
  // A "developer directory" the plugin is edited in.
  const dev = await mkdtemp(join(tmpdir(), 'hd-dev-plugin-'))
  t.after(() => rm(dev, { recursive: true, force: true }))
  await writeFile(
    join(dev, 'harnessdesk.plugin.json'),
    JSON.stringify({ id: 'dev-loop', name: 'Dev loop', main: './index.js', permissions: {} }),
  )
  const entry = (marker: string): string =>
    `export const plugin = { name: 'dev-loop', inject: ['tools'], apply(ctx) {
       ctx.tools.register({ name: 'marker', description: 'm', inputSchema: { type: 'object', properties: {} }, execute: () => '${marker}' })
     } }`
  await writeFile(join(dev, 'index.js'), entry('first'))

  const installed = await install(dev)
  const definition = await loadInstalled(installed.directory)
  // The origin survives the copy — this is what Update from source uses.
  assert.deepEqual(definition.manifest.source, { kind: 'local', path: dev })

  const kernel = new ExtensionKernel()
  await kernel.load(definition)
  await settle()
  const tool = kernel.list('tool').find((entry) => entry.name === 'marker')!
  assert.match(JSON.stringify(await kernel.invokeTool(tool.id, {}, {})), /first/)

  // The developer edits and updates. The reinstalled module must be the NEW
  // code — module caching by URL would silently serve the old one.
  await writeFile(join(dev, 'index.js'), entry('second'))
  const again = await install(dev)
  await kernel.unload('dev-loop')
  await kernel.load(await loadInstalled(again.directory))
  await settle()
  const fresh = kernel.list('tool').find((entry) => entry.name === 'marker')!
  assert.match(JSON.stringify(await kernel.invokeTool(fresh.id, {}, {})), /second/)

  // Installing the installed copy onto itself is refused with directions.
  await assert.rejects(install(installed.directory), /already the installed copy/)
  await kernel.dispose()
})

// ------------------------------------------------------- uninstall's guard

test('uninstall refuses an id that resolves to the plugins directory itself', async (t) => {
  const root = await withPluginsRoot(t)
  await install(FIXTURE)
  assert.equal((await listInstalled()).length, 1, 'installed to begin with')

  // Each of these makes `join(pluginsRoot(), id)` equal the plugins root, which
  // the old guard admitted — and `rm(recursive)` on the root takes every
  // installed plugin, not the one asked for.
  for (const id of ['', '.', './', 'demo/..']) {
    await assert.rejects(() => uninstall(id), /not an installed plugin/i, `uninstall(${JSON.stringify(id)})`)
  }
  assert.equal((await listInstalled()).length, 1, 'nothing was removed')
  await rm(join(root, 'unused'), { recursive: true, force: true })
})

test('uninstall refuses an id that escapes the plugins directory', async (t) => {
  const root = await withPluginsRoot(t)
  // A sibling whose path merely *starts with* the plugins root: the old guard
  // compared strings with no separator between them, so `<root>-backup` passed.
  const sibling = `${root}-backup`
  await mkdir(join(sibling, 'victim'), { recursive: true })
  t.after(() => rm(sibling, { recursive: true, force: true }))

  await assert.rejects(() => uninstall('../' + sibling.split('/').pop() + '/victim'), /outside|not an installed plugin/i)
  await assert.rejects(() => uninstall('../..'), /outside|not an installed plugin/i)
  await readFile(join(sibling, 'victim', '.keep'), 'utf8').catch(() => null)
  assert.ok(await mkdir(join(sibling, 'victim'), { recursive: true }).then(() => true).catch(() => false), 'the sibling survived')
})


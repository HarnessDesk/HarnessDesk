import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ExtensionKernel } from '@harnessdesk/cordis-host'
import { SupervisedExtensionHost } from '@harnessdesk/extension-host'
import type { RuntimeFiles, SessionId } from '@harnessdesk/protocol'

import { EditorPlane } from '../src/editor-plane.js'

/**
 * The editor plane, end to end: a plugin running in the isolated child
 * process shows a file, marks it, rewrites a line, and reads back what
 * happened — with none of its code in the window and none in this process.
 *
 * It lives here rather than beside the other isolation tests because both
 * halves are only in scope together at this layer: `extension-host` must not
 * import the server, and the plane is the server's. Testing it from the
 * extension-host side would mean a fake plane, which proves the boundary is
 * crossed and nothing about what is on the other side of it.
 *
 * The permission test at the end is the one that matters most. `editor` is a
 * *surface* grant; if it ever became sufficient on its own to write a file,
 * every plugin a person allowed to annotate their code would have quietly
 * gained the ability to change it.
 */

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))
const scope = { sessionId: 's1' as SessionId }

/** Only the two calls the plane makes; the rest of `RuntimeFiles` is not its business. */
const localFiles = (): RuntimeFiles =>
  ({
    read: (path: string): Promise<Uint8Array> => readFile(path),
    write: async (path: string, data: Uint8Array): Promise<void> => writeFile(path, data),
  }) as unknown as RuntimeFiles

interface Rig {
  readonly host: SupervisedExtensionHost
  readonly plane: EditorPlane
  readonly file: string
  readonly dir: string
  call(name: string, args?: unknown): Promise<{ ok: boolean; text: string }>
}

const rig = async (permissions?: unknown): Promise<Rig> => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-editor-plugin-'))
  const store = join(dir, 'plugins')
  const workspace = join(dir, 'work')
  await mkdir(workspace, { recursive: true })
  const file = join(workspace, 'a.ts')
  await writeFile(file, 'one\ntwo\nthree\n')
  await cp(join(FIXTURES, 'plugin-editor'), join(store, 'editorish'), { recursive: true })
  // Same plugin code, different manifest — the only honest way to test a gate.
  if (permissions !== undefined) {
    await writeFile(
      join(store, 'editorish', 'harnessdesk.plugin.json'),
      JSON.stringify({ id: 'editorish', name: 'e', version: '1.0.0', main: './index.js', permissions }),
    )
  }

  const plane = new EditorPlane({
    files: localFiles,
    roots: () => [workspace],
    push: () => {},
  })
  const host = new SupervisedExtensionHost(new ExtensionKernel(), {
    invokeTimeoutMs: 10_000,
    env: { HARNESSDESK_PLUGINS: store },
  })
  // Set after construction, exactly as `bootstrap` does: the plane belongs to
  // the host, and the host is built after the extension surface so a session
  // started early is not born with an empty tool set.
  host.setEditorEngine(plane)
  host.setWorkspace({ root: workspace, branch: null })
  await host.loadInstalledPlugins()

  return {
    host,
    plane,
    file,
    dir,
    async call(name, args = {}) {
      const tool = host.list('tool').find((entry) => entry.name === name)
      assert.ok(tool, `${name} is contributed from the child`)
      const result = await host.invokeTool(tool.id, args, scope)
      return {
        ok: result.ok,
        text: result.ok
          ? result.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
          : result.error,
      }
    },
  }
}

const close = async (harness: Rig): Promise<void> => {
  await harness.host.dispose()
  await rm(harness.dir, { recursive: true, force: true })
}

test('a plugin in the child shows a file and marks it, attributed to itself', async () => {
  const harness = await rig()
  try {
    assert.equal((await harness.call('review', { path: harness.file })).ok, true)
    const [document] = harness.plane.documents()
    assert.equal(document?.path, harness.file)
    // The instance is `editorish#1`; what a person needs to see against a mark
    // in their own file is the plugin.
    assert.equal(document?.pluginId, 'editorish')
    assert.equal(document?.decorations.length, 1)
    assert.equal(document?.decorations[0]?.message, 'this line is suspicious')
    assert.equal(document?.decorations[0]?.fromLine, 2)
  } finally {
    await close(harness)
  }
})

test('an agent cannot reach the write path through a plugin tool', async () => {
  const harness = await rig()
  try {
    /*
     * `format` is a formatter exposed as a tool, and a tool is a thing agents
     * call — so this is the laundering path in miniature: the grant is the
     * plugin's, the intent is the agent's, and until provenance was carried
     * nothing compared the two. the editor-plane decision says an agent's edits belong to its
     * own runtime where its own approval applies, and this is that rule being
     * kept rather than merely stated.
     *
     * The permission gates run first, so this refusal is specifically about
     * the cause: the tests below still report `workspace.write` and `editor`
     * when those are what is missing.
     */
    const formatted = await harness.call('format', { path: harness.file })
    assert.equal(formatted.ok, false)
    assert.match(formatted.text, /agent cannot write files through a plugin/)
    assert.equal(await readFile(harness.file, 'utf8'), 'one\ntwo\nthree\n', 'nothing was written')
  } finally {
    await close(harness)
  }
})

test('events are pulled across the boundary, in order, and a drain empties them', async () => {
  const harness = await rig()
  try {
    // The first drain is what registers this plugin as a reader.
    assert.deepEqual(JSON.parse((await harness.call('watch')).text), [])

    // Reported directly rather than by writing: the write path is the one
    // thing an agent cannot reach through a plugin, and what this test is
    // about is the queue crossing the process boundary in order.
    harness.plane.report({ kind: 'saved', path: harness.file, at: 0, hash: 'h' })
    harness.plane.report({ kind: 'changed', path: harness.file, at: 1 })

    const events = JSON.parse((await harness.call('watch')).text) as { kind: string }[]
    assert.deepEqual(
      events.map((event) => event.kind),
      ['saved', 'changed'],
    )
    assert.deepEqual(JSON.parse((await harness.call('watch')).text), [])
  } finally {
    await close(harness)
  }
})

test('clearing and closing takes the file off the plane', async () => {
  const harness = await rig()
  try {
    await harness.call('review', { path: harness.file })
    assert.equal(harness.plane.documents().length, 1)
    await harness.call('unmark', { path: harness.file })
    assert.deepEqual(harness.plane.documents(), [])
  } finally {
    await close(harness)
  }
})

test('without the editor grant, nothing on the plane is reachable', async () => {
  const harness = await rig({ workspace: { read: true, write: true } })
  try {
    const result = await harness.call('review', { path: harness.file })
    assert.equal(result.ok, false)
    assert.match(result.text, /editor/i)
    assert.deepEqual(harness.plane.documents(), [])
  } finally {
    await close(harness)
  }
})

test('the editor grant alone cannot write: `workspace.write` is still required', async () => {
  const harness = await rig({ editor: true, workspace: { read: true, write: false } })
  try {
    const result = await harness.call('format', { path: harness.file })
    assert.equal(result.ok, false)
    assert.match(result.text, /workspace\.write/)
    assert.equal(await readFile(harness.file, 'utf8'), 'one\ntwo\nthree\n', 'the file was not touched')

    // Showing and marking still work, which is what makes the refusal above a
    // gate on writing rather than the plane being unreachable.
    assert.equal((await harness.call('review', { path: harness.file })).ok, true)
    assert.equal(harness.plane.documents().length, 1)
  } finally {
    await close(harness)
  }
})

test('a path outside the open workspace is refused, whatever the grants say', async () => {
  const harness = await rig()
  try {
    const result = await harness.call('review', { path: '/etc/passwd' })
    assert.equal(result.ok, false)
    assert.deepEqual(harness.plane.documents(), [])
  } finally {
    await close(harness)
  }
})

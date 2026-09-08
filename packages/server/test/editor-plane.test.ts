import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { tempDir } from './scratch.js'

import type { RuntimeFiles, UiDecoration, WireNotification } from '@harnessdesk/protocol'

import { EditorPlane } from '../src/editor-plane.js'

/**
 * The editor plane, host-side.
 *
 * What has to hold: the plane is the host's, so it survives having no window;
 * marks belong to the plugin that set them, so clearing one plugin's does not
 * take another's; a write goes through the runtime's own filesystem view and
 * is confined to the roots that are actually open; and events are queued per
 * draining plugin, so two plugins watching the editor do not starve each
 * other.
 *
 * The last one is the reason this differs from `ctx.browser`, and the one
 * that would otherwise only be discovered by a user who installed a second
 * editor-aware plugin and found the first quietly stopped working.
 */

const workspace = async (): Promise<string> => tempDir('hd-editor-')

const plane = async (): Promise<{
  plane: EditorPlane
  root: string
  pushed: WireNotification[]
}> => {
  const root = await workspace()
  const pushed: WireNotification[] = []
  // Only the two the plane uses; the rest of `RuntimeFiles` is the file
  // picker's and the tree's, and standing them up here would be inventing
  // behaviour this has no opinion about.
  const files = {
    read: (path: string): Promise<Uint8Array> => readFile(path),
    write: async (path: string, data: Uint8Array): Promise<void> => writeFile(path, data),
  } as unknown as RuntimeFiles
  return {
    root,
    pushed,
    plane: new EditorPlane({
      files: () => files,
      roots: () => [root],
      push: (notification) => void pushed.push(notification),
    }),
  }
}

const mark = (fromLine: number, message: string): UiDecoration => ({
  fromLine,
  severity: 'warning',
  message,
})

test('opening a file records it and pushes the whole plane', async () => {
  const { plane: editor, root, pushed } = await plane()
  const path = join(root, 'a.ts')
  await editor.open(path, 'linter')

  assert.equal(editor.documents().length, 1)
  assert.equal(editor.documents()[0]?.path, path)
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0]?.method, 'editor/plane')
})

test('opening the same file twice is not an error and does not reset its marks', async () => {
  const { plane: editor, root } = await plane()
  const path = join(root, 'a.ts')
  await editor.decorate(path, [mark(1, 'first')], 'linter')
  await editor.open(path, 'formatter')

  assert.equal(editor.documents().length, 1)
  assert.equal(editor.documents()[0]?.decorations.length, 1)
})

test('marking a file that is not open opens it', async () => {
  // Otherwise a plugin that has found something worth pointing at also has to
  // remember to ask for the file first, and forgetting drops the marks
  // silently.
  const { plane: editor, root } = await plane()
  await editor.decorate(join(root, 'a.ts'), [mark(3, 'unused')], 'linter')
  assert.equal(editor.documents().length, 1)
})

test("clearing one plugin's marks leaves another's alone", async () => {
  const { plane: editor, root } = await plane()
  const path = join(root, 'a.ts')
  await editor.decorate(path, [mark(1, 'from the linter')], 'linter')
  await editor.decorate(path, [mark(2, 'from the review')], 'review')
  assert.equal(editor.documents()[0]?.decorations.length, 2)

  await editor.decorate(path, [], 'linter')
  const left = editor.documents()[0]?.decorations ?? []
  assert.equal(left.length, 1)
  assert.equal(left[0]?.message, 'from the review')
})

test('closing drops the document; closing one that was never open does nothing', async () => {
  const { plane: editor, root, pushed } = await plane()
  const path = join(root, 'a.ts')
  await editor.open(path, 'linter')
  const before = pushed.length

  await editor.close(join(root, 'never-opened.ts'))
  assert.equal(pushed.length, before, 'a close of nothing should not push')

  await editor.close(path)
  assert.equal(editor.documents().length, 0)
  assert.equal(pushed.length, before + 1)
})

test('applying edits writes the file, shows it, and returns the new hash', async () => {
  const { plane: editor, root } = await plane()
  const path = join(root, 'a.ts')
  await writeFile(path, 'one\ntwo\nthree\n')

  const { hash } = await editor.applyEdits(path, [{ fromLine: 2, text: 'TWO' }], 'formatter')

  assert.equal(await readFile(path, 'utf8'), 'one\nTWO\nthree\n')
  assert.match(hash, /^[0-9a-f]{64}$/)
  // The person is shown what was changed under them rather than finding it later.
  assert.equal(editor.documents().length, 1)
})

test('a path outside every open root is refused before anything is read', async () => {
  const { plane: editor } = await plane()
  await assert.rejects(() => editor.open('/etc/passwd', 'curious'))
  await assert.rejects(() => editor.applyEdits('/etc/passwd', [{ fromLine: 1, text: 'x' }], 'curious'))
  await assert.rejects(() => editor.decorate('/etc/passwd', [mark(1, 'x')], 'curious'))
})

test('each draining plugin gets every event, and draining empties only its own queue', async () => {
  const { plane: editor, root } = await plane()
  const path = join(root, 'a.ts')

  // Nothing is buffered for a plugin that has never read, so both announce
  // themselves with an empty first drain.
  assert.deepEqual(await editor.drain('linter'), [])
  assert.deepEqual(await editor.drain('formatter'), [])

  editor.report({ kind: 'opened', path, at: 1 })
  editor.report({ kind: 'changed', path, at: 2 })

  const linter = await editor.drain('linter')
  assert.deepEqual(
    linter.map((event) => event.kind),
    ['opened', 'changed'],
  )
  // The formatter's queue is untouched by the linter having read.
  const formatter = await editor.drain('formatter')
  assert.deepEqual(
    formatter.map((event) => event.kind),
    ['opened', 'changed'],
  )
  // And a second read returns nothing, rather than the same events again.
  assert.deepEqual(await editor.drain('linter'), [])
})

test('nothing is buffered for a plugin that has never drained', async () => {
  const { plane: editor, root } = await plane()
  editor.report({ kind: 'changed', path: join(root, 'a.ts'), at: 1 })
  // A host with no editor-aware plugin would otherwise accumulate a keystroke's
  // worth of this for nobody, forever.
  assert.deepEqual(await editor.drain('arriving-later'), [])
})

test('a write is reported like any other save, including to whoever made it', async () => {
  const { plane: editor, root } = await plane()
  const path = join(root, 'a.ts')
  await writeFile(path, 'one\n')
  await editor.drain('formatter')

  await editor.applyEdits(path, [{ fromLine: 1, text: 'ONE' }], 'formatter')

  const events = await editor.drain('formatter')
  assert.equal(events.length, 1)
  assert.equal(events[0]?.kind, 'saved')
  // A formatter that re-formats its own output is a bug in the formatter, and
  // hiding the event would hide the bug.
})

test('the queue is capped, keeping the newest', async () => {
  const { plane: editor, root } = await plane()
  const path = join(root, 'a.ts')
  await editor.drain('linter')
  for (let index = 0; index < 600; index += 1) {
    editor.report({ kind: 'changed', path, at: index })
  }
  const events = await editor.drain('linter')
  assert.equal(events.length, 500)
  // Oldest out: a plugin that stopped reading has stopped caring about the
  // beginning, and the alternative is a leak with a slow fuse.
  assert.equal(events.at(-1)?.at, 599)
})

test('the plane notification is the same shape on connect as on change', async () => {
  const { plane: editor, root, pushed } = await plane()
  await editor.open(join(root, 'a.ts'), 'linter')
  assert.deepEqual(editor.notification(), pushed[0])
})

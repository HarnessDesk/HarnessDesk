import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { errnoOf } from '../src/errno.js'
import { LocalFiles } from '../src/workspace.js'

/**
 * #77: `stat` follows links, so `isSymlink` was false for every link, and a
 * link whose target was gone could not be described at all.
 */
test("a link says it is one, and its kind is its target's", { skip: process.platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-local-files-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'folder'))
  await writeFile(join(dir, 'file.txt'), 'x')
  await symlink(join(dir, 'folder'), join(dir, 'to-folder'))
  await symlink(join(dir, 'file.txt'), join(dir, 'to-file'))
  await symlink(join(dir, 'nowhere'), join(dir, 'dangling'))

  const files = new LocalFiles()
  const described = async (name: string) => {
    const { kind, isSymlink } = await files.stat(join(dir, name))
    return { kind, isSymlink }
  }
  assert.deepEqual(await described('folder'), { kind: 'directory', isSymlink: false })
  assert.deepEqual(await described('file.txt'), { kind: 'file', isSymlink: false })
  assert.deepEqual(await described('to-folder'), { kind: 'directory', isSymlink: true })
  assert.deepEqual(await described('to-file'), { kind: 'file', isSymlink: true })
  assert.deepEqual(await described('dangling'), { kind: 'other', isSymlink: true })
})

/*
 * A project the finder cannot open is not a project with no files in it.
 *
 * The walk answered every folder it could not open with nothing — the
 * project's own root included, which is how a folder macOS will not let the
 * app read (EPERM, until it is granted Files and Folders) came back as "no
 * files match" from the palette and the composer's `@`. A folder *inside* the
 * project is different: one the finder cannot open must not cost the search
 * the rest of the tree, so it is passed over — and said, once.
 */

test('a project folder the filesystem refuses outright is raised, not answered as no files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-local-files-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  // 300 characters in one name: refused by every filesystem these run on, and by no mode.
  await assert.rejects(new LocalFiles().search([join(dir, 'n'.repeat(300))], 'app', 10), (error: unknown) => {
    assert.equal(errnoOf(error), 'ENAMETOOLONG')
    return true
  })
})

test('a project folder the mode refuses is raised the same way', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-local-files-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const files = new LocalFiles()
  const project = join(dir, 'project')
  await mkdir(join(project, 'src'), { recursive: true })
  await writeFile(join(project, 'src', 'app.ts'), 'x')
  assert.equal((await files.search([project], 'app', 10)).length, 1, 'readable, the file is found')
  await chmod(project, 0o000)
  try {
    const readable = await readdir(project).then(
      () => true,
      () => false,
    )
    // Modes do not apply to root, so there is no refusal here to observe.
    if (readable) return t.skip('this user can read a directory with mode 000')

    await assert.rejects(files.search([project], 'app', 10), (error: unknown) => {
      assert.equal(errnoOf(error), 'EACCES')
      return true
    })
  } finally {
    await chmod(project, 0o700)
  }
})

test('a folder inside the project the finder cannot open is passed over, and said once', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-local-files-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'src'))
  await mkdir(join(dir, 'locked'))
  await writeFile(join(dir, 'src', 'app.ts'), 'x')
  await writeFile(join(dir, 'locked', 'app-secrets.ts'), 'x')
  const locked = join(dir, 'locked')
  await chmod(locked, 0o000)
  try {
    const readable = await readdir(locked).then(
      () => true,
      () => false,
    )
    if (readable) return t.skip('this user can read a directory with mode 000')

    const logged: string[] = []
    const files = new LocalFiles({
      log: (message, details) => logged.push(`${message} ${JSON.stringify(details ?? {})}`),
    })
    const found = await files.search([dir], 'app', 10)
    assert.deepEqual(
      found.map((match) => match.relativePath),
      [join('src', 'app.ts')],
      'the rest of the project is still searched',
    )
    // A search runs per keystroke; the folder is named once, not once a keystroke.
    await files.search([dir], 'ap', 10)
    const lines = logged.filter((line) => line.includes(locked))
    assert.equal(lines.length, 1, 'and the folder it could not open is named, once')
    assert.match(lines[0] ?? '', /EACCES/)
  } finally {
    await chmod(locked, 0o700)
  }
})

test('a project folder that is gone has no files, and says nothing', async (t) => {
  // The control for the two above: this passes against the old catch-all too.
  const dir = await mkdtemp(join(tmpdir(), 'hd-local-files-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const logged: string[] = []
  const files = new LocalFiles({ log: (message) => logged.push(message) })
  assert.deepEqual(await files.search([join(dir, 'moved-away')], 'app', 10), [])
  assert.deepEqual(logged, [])
})

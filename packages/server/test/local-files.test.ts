import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { errnoOf } from '../src/errno.js'
import { confine, isBinaryFile, isMissingWorkspaceFileError, LocalFiles, sha256 } from '../src/workspace.js'
import { workspaceMethods } from '../src/methods/workspace.js'
import type { HostContext } from '../src/methods/context.js'

test('workspace reads and saves refuse file and directory links outside the opened root', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hd-local-files-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const project = join(dir, 'project')
  const outside = join(dir, 'outside')
  await mkdir(project)
  await mkdir(outside)
  await writeFile(join(outside, 'file.txt'), 'outside')
  await symlink(outside, join(project, 'linked'))
  await symlink(join(outside, 'file.txt'), join(project, 'linked-file'))
  await symlink(join(outside, 'absent.txt'), join(project, 'dangling'))
  const files = new LocalFiles()
  const ctx = { workspaces: { fileRoots: () => [project] }, runtimes: { files: () => files } } as unknown as HostContext
  for (const name of ['linked/file.txt', 'linked-file', 'dangling', 'linked/missing/deeper.txt']) {
    const path = join(project, name)
    await assert.rejects(workspaceMethods['workspace/readFile'](ctx, { path }))
    await assert.rejects(workspaceMethods['file/save'](ctx, { path, content: 'replacement', expectedHash: sha256(Buffer.from('outside')) }))
  }
  assert.equal(await readFile(join(outside, 'file.txt'), 'utf8'), 'outside')
  await assert.rejects(readFile(join(outside, 'absent.txt')), { code: 'ENOENT' })
})

test('an opened linked root and links within it retain ordinary read and save behavior', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hd-local-files-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const project = join(dir, 'project')
  const alias = join(dir, 'alias')
  await mkdir(project)
  await symlink(project, alias)
  await writeFile(join(project, 'file.txt'), 'inside')
  await symlink('file.txt', join(project, 'linked-file'))
  const files = new LocalFiles()
  const ctx = { workspaces: { fileRoots: () => [alias] }, runtimes: { files: () => files } } as unknown as HostContext
  const path = join(alias, 'linked-file')
  const read = await workspaceMethods['workspace/readFile'](ctx, { path })
  assert.equal(read.kind, 'text')
  const saved = await workspaceMethods['file/save'](ctx, { path, content: 'changed', expectedHash: sha256(Buffer.from('inside')) })
  assert.equal(saved.saved, true)
  assert.equal(await readFile(join(project, 'file.txt'), 'utf8'), 'changed')
  assert.equal(confine(join(alias, 'missing', 'deeper.txt'), [alias]), join(alias, 'missing', 'deeper.txt'))
})

test('LocalFiles refuses a parent link introduced just before opening content', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hd-local-files-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const outside = join(dir, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'file.txt'), 'outside')
  const fsp = createRequire(import.meta.url)('node:fs/promises') as { open: typeof open }
  const original = fsp.open
  t.after(() => { fsp.open = original; syncBuiltinESMExports() })
  for (const operation of ['read', 'write'] as const) {
    const parent = join(dir, operation)
    await mkdir(parent)
    await writeFile(join(parent, 'file.txt'), 'inside')
    let swapped = false
    fsp.open = async (path, flags, mode) => {
      const requested = String(path)
      const beforeParent = process.platform === 'linux' && requested.endsWith(`/${operation}`)
        && (Number(flags) & constants.O_DIRECTORY) !== 0
      if (!swapped && (requested === join(parent, 'file.txt') || beforeParent)) {
        swapped = true
        await rename(parent, `${parent}-kept`)
        await symlink(outside, parent)
      }
      return original(path, flags, mode)
    }
    syncBuiltinESMExports()
    const files = new LocalFiles()
    await assert.rejects(operation === 'read' ? files.read(join(parent, 'file.txt'), 64) : files.write(join(parent, 'file.txt'), Buffer.from('replacement')))
    assert.equal(swapped, true)
    assert.equal(await readFile(join(outside, 'file.txt'), 'utf8'), 'outside')
  }
})

test('LocalFiles rechecks roots when a previously admitted parent now leads outside', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hd-local-files-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const project = join(dir, 'project')
  const outside = join(dir, 'outside')
  await mkdir(project)
  await mkdir(outside)
  await mkdir(join(project, 'nested'))
  await writeFile(join(outside, 'file.txt'), 'outside')
  const admitted = confine(join(project, 'nested', 'file.txt'), [project])
  await rename(join(project, 'nested'), join(project, 'kept'))
  await symlink(outside, join(project, 'nested'))
  const files = new LocalFiles({ roots: () => [project] })
  await assert.rejects(files.read(admitted, 64), /outside every open workspace/)
  await assert.rejects(files.write(admitted, Buffer.from('replacement')), /outside every open workspace/)
  assert.equal(await readFile(join(outside, 'file.txt'), 'utf8'), 'outside')
})

test('UTF-8 source stays text while invalid UTF-8 and NUL bytes are binary', () => {
  assert.equal(isBinaryFile(Buffer.from('const привет = "ok";\n')), false)
  assert.equal(isBinaryFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])), true)
  assert.equal(isBinaryFile(Buffer.from('text\0with nul')), true)
})

test('missing reads use explicit host and Codex app-server error shapes', () => {
  assert.equal(isMissingWorkspaceFileError(Object.assign(new Error('missing'), { code: 'ENOENT' })), true)
  assert.equal(isMissingWorkspaceFileError({ rpcCode: -32600, message: 'No such file or directory (os error 2)' }), true)
  assert.equal(isMissingWorkspaceFileError({ rpcCode: -32600, message: 'Invalid request' }), false)
  assert.equal(isMissingWorkspaceFileError(Object.assign(new Error('Permission denied'), { code: 'EACCES' })), false)
})

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

test('LocalFiles reads at most the requested byte bound and reports file size from stat', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-local-files-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'bounded.txt')
  await writeFile(path, Buffer.alloc(4096, 0x61))
  const files = new LocalFiles()

  assert.equal((await files.stat(path)).size, 4096)
  assert.equal((await files.read(path, 128)).byteLength, 128)
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

test('a project folder that is a file is raised, not answered as no files', async (t) => {
  /* Only ENOENT is nothing at the root: the folder the finder was asked to
     search has to be a folder, so a file at it, or above it, is raised with
     everything else. Below the root it is different — an entry listed as a
     folder that is a file a moment later is the walk racing somebody, and is
     nothing. (Review of #765.) */
  const dir = await mkdtemp(join(tmpdir(), 'hd-local-files-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'project')
  await writeFile(file, 'somebody touched this instead of making it\n')
  const files = new LocalFiles()
  for (const root of [file, join(file, 'packages')]) {
    await assert.rejects(files.search([root], 'app', 10), (error: unknown) => {
      assert.equal(errnoOf(error), 'ENOTDIR')
      return true
    })
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

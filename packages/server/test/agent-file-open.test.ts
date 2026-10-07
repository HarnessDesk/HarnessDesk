import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { mkdir, open, readFile, realpath, rename, symlink, writeFile, type FileHandle } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { openAgentFile } from '../src/agent-file-open.js'
import { tempDir } from './scratch.js'

/**
 * Linux runs the real /proc opens. On macOS, only that lookup is emulated:
 * each directory descriptor keeps its opened directory when we rename it.
 * File opens, flags, symlink refusals and bytes still use the real fs.
 */
const rig = async (t: TestContext, swapAt?: 'folder' | 'file') => {
  const root = await realpath(tempDir('hd-agent-open-'))
  const nested = join(root, 'nested')
  const moved = join(root, 'kept')
  const outside = join(root, 'outside')
  await mkdir(nested)
  await mkdir(outside)
  await writeFile(join(nested, 'AGENT.md'), 'inside bytes')
  await writeFile(join(outside, 'AGENT.md'), 'outside bytes')
  const fsp = createRequire(import.meta.url)('node:fs/promises') as { open: typeof open }
  const realOpen = fsp.open
  const heldPaths = new Map<number, string>()
  const handles: FileHandle[] = []
  const directories: FileHandle[] = []
  const calls: string[] = []
  let swapped = false
  fsp.open = async (path, flags, mode) => {
    const requested = String(path)
    calls.push(requested)
    if (!swapped && swapAt && requested.endsWith(swapAt === 'folder' ? '/nested' : '.md')) {
      swapped = true
      await rename(nested, moved)
      await symlink(outside, nested)
      // A held fd follows the moved directory, never the new name's link.
      for (const [fd, at] of heldPaths) {
        if (at === nested || at.startsWith(`${nested}/`)) heldPaths.set(fd, moved + at.slice(nested.length))
      }
    }
    let actual = requested
    const relative = /^\/proc\/self\/fd\/(\d+)\/([^/]+)$/.exec(requested)
    if (relative && process.platform !== 'linux') {
      const parent = heldPaths.get(Number(relative[1]))
      assert.ok(parent, 'descriptor-relative opens use a still-open parent')
      actual = join(parent, relative[2]!)
    }
    const handle = await realOpen(actual, flags, mode)
    handles.push(handle)
    if ((await handle.stat()).isDirectory()) {
      assert.equal(Number(flags) & constants.O_NOFOLLOW, constants.O_NOFOLLOW)
      directories.push(handle)
      heldPaths.set(handle.fd, actual)
    }
    return handle
  }
  syncBuiltinESMExports()
  t.after(async () => {
    await Promise.all(handles.map((handle) => handle.close()))
    fsp.open = realOpen
    syncBuiltinESMExports()
  })
  return { nested, moved, outside, directories, calls, swapped: () => swapped }
}

test('Linux: a link swapped in before a directory is opened is refused', async (t) => {
  const { nested, directories, swapped } = await rig(t, 'folder')
  await assert.rejects(openAgentFile(join(nested, 'AGENT.md'), constants.O_RDONLY, undefined, 'linux'), { code: 'ELOOP' })
  assert.ok(swapped())
  assert.ok(directories.length > 0, 'traversal opened directory descriptors')
  assert.ok(directories.every((handle) => handle.fd === -1), 'failed traversal closes every directory')
})

test('Linux: a link swapped in after the parent is opened cannot redirect a read', async (t) => {
  const { nested, directories, swapped } = await rig(t, 'file')
  const handle = await openAgentFile(join(nested, 'AGENT.md'), constants.O_RDONLY, undefined, 'linux')
  try {
    assert.equal(await handle.readFile('utf8'), 'inside bytes')
    assert.ok(swapped())
    assert.ok(directories.length > 0, 'traversal opened directory descriptors')
    assert.ok(directories.every((directory) => directory.fd === -1), 'only the content descriptor survives')
  } finally {
    await handle.close()
  }
})

test('Linux: a link swapped in after the parent is opened cannot redirect an exclusive write', async (t) => {
  const { nested, moved, outside, directories, swapped } = await rig(t, 'file')
  const handle = await openAgentFile(join(nested, 'NEW-AGENT.md'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600, 'linux')
  try {
    await handle.writeFile('new inside bytes')
  } finally {
    await handle.close()
  }
  assert.ok(swapped())
  assert.equal(await readFile(join(moved, 'NEW-AGENT.md'), 'utf8'), 'new inside bytes')
  await assert.rejects(readFile(join(outside, 'NEW-AGENT.md')), { code: 'ENOENT' })
  assert.ok(directories.every((directory) => directory.fd === -1))
})

test('Linux: a final link is refused and a collision is never overwritten', async (t) => {
  const { nested, outside, directories } = await rig(t)
  await symlink(join(outside, 'AGENT.md'), join(nested, 'link.md'))
  await assert.rejects(openAgentFile(join(nested, 'link.md'), constants.O_RDONLY, undefined, 'linux'), { code: 'ELOOP' })
  await assert.rejects(openAgentFile(join(nested, 'AGENT.md'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, undefined, 'linux'), { code: 'EEXIST' })
  assert.equal(await readFile(join(nested, 'AGENT.md'), 'utf8'), 'inside bytes')
  assert.ok(directories.every((directory) => directory.fd === -1))
})

test('unsupported platforms refuse content opens before reading or creating a file', async (t) => {
  const { nested, calls } = await rig(t)
  await assert.rejects(openAgentFile(join(nested, 'AGENT.md'), constants.O_RDONLY, undefined, 'win32'), { code: 'ENOTSUP' })
  await assert.rejects(openAgentFile(join(nested, 'new.md'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, undefined, 'win32'), { code: 'ENOTSUP' })
  assert.deepEqual(calls, [])
})

test('Linux: invalid paths refuse before traversal and a missing file closes its parents', async (t) => {
  const { nested, directories, calls } = await rig(t)
  for (const path of ['relative.md', '/a/../file.md', '/a/./file.md', '/a//file.md', '/']) {
    await assert.rejects(openAgentFile(path, constants.O_RDONLY, undefined, 'linux'), { code: 'EINVAL' })
  }
  assert.deepEqual(calls, [])
  await assert.rejects(openAgentFile(join(nested, 'missing.md'), constants.O_RDONLY, undefined, 'linux'), { code: 'ENOENT' })
  assert.ok(directories.length > 0)
  assert.ok(directories.every((directory) => directory.fd === -1))
})

test('Linux: an unavailable descriptor lookup refuses rather than falling back to the original path', async (t) => {
  const { nested, directories, calls } = await rig(t)
  const fsp = createRequire(import.meta.url)('node:fs/promises') as { open: typeof open }
  const rigOpen = fsp.open
  fsp.open = async (path, flags, mode) => {
    if (String(path).startsWith('/proc/self/fd/')) {
      throw Object.assign(new Error('procfs unavailable'), { code: 'ENOENT' })
    }
    return rigOpen(path, flags, mode)
  }
  syncBuiltinESMExports()
  await assert.rejects(openAgentFile(join(nested, 'AGENT.md'), constants.O_RDONLY, undefined, 'linux'), { code: 'ENOENT' })
  assert.deepEqual(calls, ['/'], 'no direct content open followed the missing procfs')
  assert.ok(directories.every((directory) => directory.fd === -1))
})

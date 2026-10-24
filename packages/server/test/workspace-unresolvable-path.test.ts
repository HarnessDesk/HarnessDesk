import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { PathUnresolvableError, confine } from '../src/workspace.js'
import { Client, start, stop } from './fixtures/harness.js'

/**
 * A path the disk will not say where it leads is a file in some state, not an
 * error nobody can read.
 *
 * Confinement has to know where a path really leads, and a link loop or a
 * folder nobody can search makes that unanswerable. The editor is built around
 * a tagged answer for such a file — gone, or there but not readable — and it
 * got one before confinement looked at the disk. So the failure is raised as
 * its own kind of error, not as the operating system's, and the one request
 * that has a tagged answer gives it.
 */

const scratch = async (t: TestContext): Promise<string> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hd-unresolvable-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Whether this user is refused a folder with no mode, which root is not. */
const cannotSearch = async (folder: string): Promise<boolean> => readdir(folder).then(() => false, () => true)

test('a path that loops through links is neither admitted nor refused as outside, but raised as unresolvable', async (t) => {
  const dir = await scratch(t)
  const root = join(dir, 'project')
  await mkdir(root)
  await symlink('loop', join(root, 'loop'))
  await symlink('b', join(root, 'a'))
  await symlink('a', join(root, 'b'))
  for (const name of ['loop', 'a', join('loop', 'file.txt')]) {
    await assert.rejects(
      confine(join(root, name), [root]),
      (error: unknown) => error instanceof PathUnresolvableError && error.code === 'ELOOP' && !/outside every open workspace/.test(error.message),
      name,
    )
  }
})

test('a folder that cannot be searched is raised as unresolvable, with the reason the system gave', async (t) => {
  const dir = await scratch(t)
  const root = join(dir, 'project')
  const locked = join(root, 'locked')
  await mkdir(locked, { recursive: true })
  await writeFile(join(locked, 'file.txt'), 'x')
  await chmod(locked, 0o000)
  try {
    if (!(await cannotSearch(locked))) return t.skip('this user can read a directory with mode 000')
    await assert.rejects(
      confine(join(locked, 'file.txt'), [root]),
      (error: unknown) => error instanceof PathUnresolvableError && error.code === 'EACCES' && /permission denied/i.test(error.message),
    )
  } finally {
    await chmod(locked, 0o700)
  }
})

test('names that are not there yet are still admitted, and a path outside is still refused as outside', async (t) => {
  const dir = await scratch(t)
  const root = join(dir, 'project')
  await mkdir(root)
  assert.equal(await confine(join(root, 'not', 'here', 'yet.txt'), [root]), join(root, 'not', 'here', 'yet.txt'))
  await assert.rejects(
    confine(join(dir, 'elsewhere.txt'), [root]),
    (error: unknown) => !(error instanceof PathUnresolvableError) && /outside every open workspace/.test((error as Error).message),
  )
})

test('workspace/readFile answers a link loop and an unsearchable folder as unreadable, and a link that leads nowhere as missing', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  await client.call('workspace/open', { path: harness.stateDir })
  const root = harness.stateDir

  await symlink('loop', join(root, 'loop'))
  const looped = (await client.call('workspace/readFile', { path: join(root, 'loop') })) as { kind: string; message?: string }
  assert.equal(looped.kind, 'unreadable')
  assert.match(looped.message ?? '', /too many symbolic links|ELOOP/i)

  // The kernel answers a name below one that is not there with "no such file", and the editor reads that as gone.
  await symlink('nothing/../x', join(root, 'leads-nowhere'))
  assert.deepEqual(await client.call('workspace/readFile', { path: join(root, 'leads-nowhere') }), { kind: 'missing' })

  const locked = join(root, 'locked')
  await mkdir(locked)
  await writeFile(join(locked, 'file.txt'), 'x')
  await chmod(locked, 0o000)
  try {
    if (await cannotSearch(locked)) {
      const refused = (await client.call('workspace/readFile', { path: join(locked, 'file.txt') })) as { kind: string; message?: string }
      assert.equal(refused.kind, 'unreadable')
      assert.match(refused.message ?? '', /permission denied|EACCES/i)
    }
  } finally {
    await chmod(locked, 0o700)
  }

  // A path outside every open workspace is still refused, not answered as a file.
  await assert.rejects(client.call('workspace/readFile', { path: join(tmpdir(), 'not-opened.txt') }), /outside every open workspace/)
})

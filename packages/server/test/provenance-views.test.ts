import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, lstat, mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import type { EvidencePlane } from '../src/evidence/plane.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { admitProject, gitReader, sweepViews } from '../src/provenance/git.js'
import { ProvenancePlane } from '../src/provenance/plane.js'
import { makeRepo } from './fixtures/provenance-repo.js'
import { tempDir } from './scratch.js'

const waitUntil = async (condition: () => boolean | Promise<boolean>, name: string): Promise<void> => {
  const deadline = Date.now() + 15000
  while (!await condition()) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${name}`)
    await delay(20)
  }
}
const views = async (stateDir: string): Promise<string[]> =>
  (await readdir(stateDir)).filter((name) => name.startsWith('provenance-view-')).sort()
const absent = (path: string) => assert.rejects(access(path), { code: 'ENOENT' })

/** A pid no process has: past the largest the operating systems hand out. */
const NOBODY = 2_147_483_646

const planeFor = (repo: { dir: string; stateDir: string }, store: unknown, projects: readonly string[] = [repo.dir]) =>
  new ProvenancePlane({
    evidence: { store, seats: { byId: () => null } } as unknown as EvidencePlane,
    stateDir: repo.stateDir, projects: () => projects, push: () => {}, log: () => {},
  })

test('a failed admission leaves no view folder behind', async () => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  await repo.git('update-ref', 'refs/heads/main', base)
  const real = new EvidenceStore(join(repo.stateDir, 'evidence'))
  const blocker = join(repo.stateDir, 'not-a-folder')
  await writeFile(blocker, 'a file where the evidence folder is needed')
  let broken = false
  const plane = planeFor(repo, {
    folderOf: (project: string) => broken ? join(blocker, 'evidence') : real.folderOf(project),
    read: (project: string, file: 'seats' | 'evidence') => real.read(project, file),
    projects: () => real.projects(),
  })
  try {
    await plane.start()
    await waitUntil(async () => (await views(repo.stateDir)).length === 1 && (await plane.status().catch(() => [])).length === 1,
      'the project to be admitted')
    broken = true
    // The retry admits the project again and then cannot open its evidence folder.
    await assert.rejects(plane.retry(repo.dir))
    assert.deepEqual(await views(repo.stateDir), [], 'a retry that cannot open keeps nothing it admitted')
  } finally {
    await plane.close()
  }
  assert.deepEqual(await views(repo.stateDir), [])
})

test('closing the plane leaves no view folder, whether or not its project was admitted yet', async () => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  await repo.git('update-ref', 'refs/heads/main', base)
  const store = new EvidenceStore(join(repo.stateDir, 'evidence'))
  const settled = planeFor(repo, store)
  await settled.start()
  await waitUntil(async () => (await views(repo.stateDir)).length === 1, 'the project to be admitted')
  await settled.close()
  assert.deepEqual(await views(repo.stateDir), [])
  const early = planeFor(repo, store)
  const starting = early.start()
  await early.close()
  await starting
  assert.deepEqual(await views(repo.stateDir), [], 'a quit while the project is still being admitted')
})

/** Run a module script in a process of its own and say how it ended. */
const inChild = (script: string, ...args: string[]) => new Promise<{ out: string; code: number | null }>((resolve, reject) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
  const out: Buffer[] = []
  child.stdout.on('data', (bytes: Buffer) => out.push(bytes))
  child.on('error', reject)
  child.on('close', (code) => resolve({ out: Buffer.concat(out).toString('utf8'), code }))
})

test('a process that ends without closing its readers leaves no view folder', async () => {
  const repo = await makeRepo()
  await repo.commitTree(null, { one: 'base\n' }, 'base')
  const git = new URL('../src/provenance/git.js', import.meta.url).href
  for (const [ending, code] of [['process.exit(0)', 0], ['throw new Error("an uncaught error")', 1]] as const) {
    const ended = await inChild(`
      const { admitProject } = await import(process.argv[1])
      const handle = await admitProject(process.argv[2], process.argv[3], [process.argv[2]])
      process.stdout.write(handle.viewDir + '\\n')
      ${ending}
    `, git, repo.dir, repo.stateDir)
    assert.equal(ended.code, code)
    const viewDir = ended.out.trim()
    assert.ok(viewDir.startsWith(join(repo.stateDir, 'provenance-view-')), `the view was ${viewDir}`)
    await absent(viewDir)
    assert.deepEqual(await views(repo.stateDir), [], ending)
  }
})

test('a closed view is gone, and closing it again is harmless', async () => {
  const repo = await makeRepo()
  await repo.commitTree(null, { one: 'base\n' }, 'base')
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  await access(handle.viewDir)
  await gitReader(handle).close()
  await absent(handle.viewDir)
  await gitReader(handle).close()
  assert.deepEqual(await views(repo.stateDir), [], 'closing twice is harmless')
})

test('startup removes the view folders no live handle owns and keeps the one in use', async () => {
  const repo = await makeRepo()
  await repo.commitTree(null, { one: 'base\n' }, 'base')
  const outside = tempDir('hd-outside-')
  await writeFile(join(outside, 'sentinel'), 'a folder outside the state folder')
  const inUse = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  const stale = ['provenance-view-AbC123', 'provenance-view-zzzzzz', `provenance-view-${NOBODY}-q1w2e3`]
  for (const name of stale) {
    await mkdir(join(repo.stateDir, name, 'objects'), { recursive: true })
    await writeFile(join(repo.stateDir, name, 'HEAD'), 'ref: refs/heads/capture\n')
  }
  // Not ours to remove: another live process's view, names that are not a view's, a file and a link.
  const foreign = `provenance-view-${process.ppid}-r4t5y6`
  const folders = [foreign, 'provenance-view-short', 'provenance-view-toolong1', 'provenance-viewer', 'previous-provenance-view-abcdef']
  for (const name of folders) await mkdir(join(repo.stateDir, name))
  await writeFile(join(repo.stateDir, 'provenance-view-a1b2c3'), 'a file, not a folder')
  await symlink(outside, join(repo.stateDir, 'provenance-view-LnK123'))
  const plane = planeFor(repo, new EvidenceStore(join(repo.stateDir, 'evidence')), [])
  try {
    await plane.start()
    const here = inUse.viewDir.slice(repo.stateDir.length + 1)
    assert.deepEqual((await readdir(repo.stateDir)).sort(), [
      ...folders, 'provenance-view-LnK123', 'provenance-view-a1b2c3', here,
    ].sort())
    await access(join(inUse.viewDir, 'HEAD'))
    assert.equal((await lstat(join(repo.stateDir, 'provenance-view-LnK123'))).isSymbolicLink(), true)
    await access(join(outside, 'sentinel'))
  } finally {
    await plane.close()
    await gitReader(inUse).close()
  }
})

test('a sweep says what it removed, leaves what it did not make, and does not need a state folder', async () => {
  const repo = await makeRepo()
  assert.deepEqual(await sweepViews(join(repo.stateDir, 'never-made')), [])
  assert.deepEqual(await sweepViews(repo.stateDir), [])
  await mkdir(join(repo.stateDir, 'provenance-view-old001', 'refs'), { recursive: true })
  await mkdir(join(repo.stateDir, `provenance-view-${NOBODY}-old002`))
  await mkdir(join(repo.stateDir, `provenance-view-${process.pid}-old003`))
  assert.deepEqual([...await sweepViews(repo.stateDir)].sort(), [
    `provenance-view-${NOBODY}-old002`, `provenance-view-${process.pid}-old003`, 'provenance-view-old001',
  ].sort())
  assert.deepEqual(await sweepViews(repo.stateDir), [])
  assert.deepEqual(await readdir(repo.stateDir), [])
})

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { StateStore } from '../src/state.js'

/**
 * Stable opaque ids and a versioned local store. The properties that matter:
 * an identity is minted once and then permanent — across restarts, across a
 * workspace being touched again — and a file from a newer format is refused
 * whole, never quietly rewritten as the older one. The ids exist for later
 * phases to attach things to; the refusal exists so a downgrade cannot
 * destroy exactly the state it was supposed to keep.
 */

const dirFor = () => mkdtemp(join(tmpdir(), 'hd-state-'))

test('the installation id is minted once and survives a reload', async (t) => {
  const dir = await dirFor()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'state.json')

  const first = new StateStore(file)
  await first.load()
  const minted = first.installId
  assert.match(minted, /[0-9a-f-]{36}/)

  // A different process, later: the same identity, read from disk.
  const second = new StateStore(file)
  await second.load()
  assert.equal(second.installId, minted)

  const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  assert.equal(raw['version'], 1)
  assert.equal(raw['installId'], minted)
})

test('a workspace keeps its id through touches, renames and restarts', async (t) => {
  const dir = await dirFor()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'state.json')

  const store = new StateStore(file)
  await store.load()
  const [entry] = await store.touchWorkspace({ path: '/repo/app', name: 'app', lastOpenedAt: 1 })
  assert.ok(entry?.id)

  // Touched again with a new display name and time: same identity.
  const [touched] = await store.touchWorkspace({ path: '/repo/app', name: 'renamed', lastOpenedAt: 2 })
  assert.equal(touched?.id, entry?.id)
  assert.equal(touched?.name, 'renamed')

  const reloaded = new StateStore(file)
  const state = await reloaded.load()
  assert.equal(state.workspaces[0]?.id, entry?.id)
})

test('entries from before ids existed get theirs on first load, durably', async (t) => {
  const dir = await dirFor()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'state.json')
  await writeFile(
    file,
    JSON.stringify({
      workspaces: [{ path: '/old', name: 'old', lastOpenedAt: 1 }],
      preferences: { theme: 'dark' },
    }),
  )

  const store = new StateStore(file)
  const state = await store.load()
  const id = state.workspaces[0]?.id
  assert.ok(id, 'the pre-id entry was given one')
  assert.equal(state.preferences['theme'], 'dark', 'nothing else about the file changed')

  const raw = JSON.parse(await readFile(file, 'utf8')) as { workspaces: { id?: string }[] }
  assert.equal(raw.workspaces[0]?.id, id, 'the minted id was written, not held in memory')
})

test('a file from a newer format is refused whole and never written', async (t) => {
  const dir = await dirFor()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'state.json')
  const future = JSON.stringify({ version: 2, somethingNew: true, preferences: {} })
  await writeFile(file, future)

  const store = new StateStore(file)
  await assert.rejects(store.load(), /newer HarnessDesk/)
  await assert.rejects(store.setPreferences({ theme: 'dark' }), /refused/)
  assert.equal(await readFile(file, 'utf8'), future, 'the newer file is byte-for-byte untouched')
})

test('a corrupt file still starts fresh — refusal is only for versions', async (t) => {
  const dir = await dirFor()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'state.json')
  await writeFile(file, '{ not json')
  const store = new StateStore(file)
  const state = await store.load()
  assert.deepEqual(state.workspaces, [])
  assert.ok(store.installId)
})

test('a preference is replaced whole — the merge is one level deep — and a reload reads the same', async (t) => {
  // The UI leans on this: the profile is written whole because a name sent
  // alone replaces the stored profile, and Reset writes `{}` because `{}`
  // replaces it. A merge one level deeper would keep a face the user reset.
  const dir = await dirFor()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'state.json')
  const store = new StateStore(file)
  await store.load()
  await store.setPreferences({ theme: 'dark', profile: { name: 'Jane', avatar: 'dj' } })
  await store.setPreferences({ profile: { name: 'JD' } })
  assert.deepEqual(store.state.preferences['profile'], { name: 'JD' })
  await store.setPreferences({ profile: {} })
  assert.deepEqual(store.state.preferences['profile'], {})
  // The control: a preference the patch does not name is untouched.
  assert.equal(store.state.preferences['theme'], 'dark')

  const again = new StateStore(file)
  await again.load()
  assert.deepEqual(again.state.preferences['profile'], {})
  assert.equal(again.state.preferences['theme'], 'dark')
})

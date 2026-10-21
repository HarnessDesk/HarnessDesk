import { expect, it } from 'vitest'
import type { AppStore } from '../state/store'
import { renamed, withRealNames, withRealNamesAlways } from '../../site-demo/real-names'

class Opaque { label = 'Alpha' }

/** Just the parts of a store the renaming touches. */
const fakeStore = () => {
  const snapshot: Record<string, unknown> = { title: 'Alpha', runtimes: new Map([['a', { name: 'Assistant B' }]]), models: [{ displayName: 'Model A' }] }
  const store = {
    getSnapshot: () => snapshot,
    transport: { request: async () => ({ agent: 'Gamma', model: 'Model D' }) },
    patched: [] as unknown[],
    patch(partial: unknown) { this.patched.push(partial) },
    teamPeers: async () => [{ agent: 'Delta' }],
  }
  return store as unknown as AppStore & { patched: unknown[]; patch: (partial: unknown) => void }
}

it('renames placeholder names inside maps, arrays and plain objects, and leaves class instances alone', () => {
  const opaque = new Opaque()
  const out = renamed({ a: ['Beta', { b: new Map([['k', 'Gamma']]) }], opaque, number: 3 })
  expect(out.a[0]).toBe('Claude Code')
  expect((out.a[1] as { b: Map<string, string> }).b.get('k')).toBe('Cursor')
  expect(out.opaque).toBe(opaque)
  expect(out.number).toBe(3)
})

it('gives the fourth seat and its model their own names', () => {
  expect(renamed(['Delta', 'Assistant D', 'Model A', 'Model D'])).toEqual(['Codex 2', 'Codex 2', 'Sol', 'Sol High'])
})

it('survives a cycle', () => {
  const loop: Record<string, unknown> = { name: 'Alpha' }
  loop['self'] = loop
  const out = renamed(loop)
  expect(out['name']).toBe('Codex')
  expect(out['self']).toBe(out)
})

it('renames the snapshot and every transport reply', async () => {
  const store = withRealNames(fakeStore())
  const snapshot = store.getSnapshot() as unknown as { title: string; models: { displayName: string }[] }
  expect(snapshot.title).toBe('Codex')
  expect(snapshot.models[0]!.displayName).toBe('Sol')
  expect(await store.transport.request('x' as never, undefined as never)).toEqual({ agent: 'Cursor', model: 'Sol High' })
})

it('also renames later patches and peer lists', async () => {
  const store = withRealNamesAlways(fakeStore())
  store.patch({ title: 'Beta' } as never)
  expect(store.patched).toEqual([{ title: 'Claude Code' }])
  expect(await store.teamPeers('room' as never)).toEqual([{ agent: 'Codex 2' }])
})

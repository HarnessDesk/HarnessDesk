import { expect, it, vi } from 'vitest'
import { runtimeId, type RuntimeCatalog } from '@harnessdesk/protocol'
import { AppStore } from './store'

it('preserves a catalogue read rejection so a failed refresh cannot masquerade as an empty catalogue', async () => {
  const store = new AppStore('ws://localhost:0/')
  const request = vi.spyOn(store.transport, 'request').mockResolvedValue(null as never)
  await store.selectRuntime(runtimeId('test-runtime'))
  request.mockClear()
  const error = new Error('Runtime unavailable')
  const catalog: RuntimeCatalog = { plugins: [], marketplaces: ['test'], loadErrors: [], featured: [] }
  request.mockRejectedValueOnce(error).mockResolvedValueOnce(catalog as never)
  await expect(store.loadCatalog()).rejects.toBe(error)
  await expect(store.loadCatalog()).resolves.toEqual(catalog)
  expect(request).toHaveBeenNthCalledWith(1, 'runtime/catalog', { runtime: runtimeId('test-runtime') })
  expect(request).toHaveBeenNthCalledWith(2, 'runtime/catalog', { runtime: runtimeId('test-runtime') })
})

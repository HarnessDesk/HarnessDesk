import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { runtimeId, type LibraryEntry } from '@harnessdesk/protocol'
import { AppStore } from '../state/store'
import { StoreProvider } from '../state/context'
import { McpSheet } from './McpSheet'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined, box: HTMLDivElement | undefined
const one = runtimeId('one'), two = runtimeId('two')
afterEach(() => { act(() => root?.unmount()); box?.remove(); vi.restoreAllMocks() })
const mount = async (stale = false, over: Partial<LibraryEntry> = {}) => {
  const store = new AppStore('ws://localhost:0/'), flow = vi.fn(), changed = vi.fn()
  const request = vi.spyOn(store.transport, 'request').mockImplementation(async method => (method === 'library/definition' ? { text: '{"command":"tools"}' } : { refreshed: false, reason: 'A turn is running.' }) as never)
  const entry: LibraryEntry = { kind: 'mcp', name: 'tools', title: null, description: 'Workspace tools.', copies: [{ path: '/home/jane/.one/mcp.json', scope: 'user', readBy: [one], hollow: false, digest: 'same', readOnly: false }], reach: [{ runtime: one, state: stale ? 'stale' : 'reaches', basis: 'reported' }, { runtime: two, state: 'absent', basis: 'scanned' }], ...over }
  box = document.createElement('div'); document.body.append(box); root = createRoot(box)
  await act(async () => root!.render(<StoreProvider store={store}><McpSheet entry={entry} columns={[{ id: one, label: 'Runtime 1' }, { id: two, label: 'Runtime 2' }]} cwd={undefined} home="/home/jane" hosts={{ mcp: new Set([one, two]) }} onFlow={flow} onChanged={changed} onClose={vi.fn()} /></StoreProvider>))
  return { request, flow }
}
it('keeps MCP Add and per-copy Remove on the existing reviewed intents', async () => {
  const { request, flow } = await mount()
  expect(request).toHaveBeenCalledWith('library/definition', { kind: 'mcp', name: 'tools', path: '/home/jane/.one/mcp.json' })
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Add to Runtime 2')!.click())
  expect(flow).toHaveBeenCalledWith({ type: 'plan', title: 'Add tools for Runtime 2', intents: [{ kind: 'installMcp', name: 'tools', sourcePath: '/home/jane/.one/mcp.json', targetRuntime: two }] })
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Remove tools from /home/jane/.one/mcp.json"]')!.click())
  expect(flow).toHaveBeenCalledWith({ type: 'plan', title: 'Remove tools', intents: [{ kind: 'removeMcp', name: 'tools', path: '/home/jane/.one/mcp.json' }] })
})
it('keeps MCP stale reread and the runtime refusal visible', async () => {
  const { request } = await mount(true)
  const reread = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Have it look again')
  expect(reread).toBeTruthy()
  await act(async () => reread!.click())
  expect(request).toHaveBeenCalledWith('runtime/refreshCatalog', { runtime: one })
  expect(document.querySelector('[data-slot="mcp-sheet"]')!.textContent).toContain('Runtime 1 — A turn is running.')
})

it('keeps the existing MCP no-target diagnostic when copies disagree', async () => {
  await mount(false, { copies: [
    { path: '/home/jane/.one/mcp.json', scope: 'user', readBy: [one], hollow: false, digest: 'first', readOnly: false },
    { path: '/home/jane/.two/mcp.json', scope: 'user', readBy: [], hollow: false, digest: 'second', readOnly: false },
  ], reach: [{ runtime: one, state: 'reaches', basis: 'scanned' }, { runtime: two, state: 'unhostable', basis: 'scanned' }] })
  expect(document.querySelector('[data-slot="mcp-sheet"]')!.textContent).toContain('Resolve the copies before installing anywhere else.')
})


it('bounds an opaque MCP identifier while retaining its full text, definition and install action', async () => {
  const name = 'workspace-tools-' + 'opaque-identifier-'.repeat(100)
  await mount(false, { name })
  const sheet = document.querySelector('[data-slot="mcp-sheet"]')!
  const description = sheet.querySelector('[data-slot="dialog-description"]')!
  expect(description.textContent).toBe(name)
  expect(description.hasAttribute('data-scroll')).toBe(true)
  expect(sheet.querySelector('[data-slot="modal-dialog-body"]')?.textContent).toContain('Workspace tools.')
  expect([...sheet.querySelectorAll('button')].some(button => button.textContent === 'Add to Runtime 2')).toBe(true)
})

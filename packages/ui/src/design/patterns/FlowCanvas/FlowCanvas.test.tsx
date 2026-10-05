import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FlowCanvas, type FlowCanvasNode, type FlowCanvasProps } from '../FlowCanvas'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
const nodes: FlowCanvasNode[] = [
  { id: 'write', position: { x: 0, y: 0 }, data: { name: 'Write', kind: 'agent', roleLine: 'Implementer', seatLine: 'One seat' }, selected: true },
  { id: 'check', position: { x: 300, y: 0 }, data: { name: 'Check', kind: 'check', roleLine: 'Tests', seatLine: 'One check' }, state: 'done', stateSlot: <span>Passed in 2m</span> },
]
const edges = [{ id: 'rule', source: 'write', target: 'check', label: 'ready' }]

beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('react-flow__node') ? 232 : 960 })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('react-flow__node') ? 108 : 600 })
  vi.stubGlobal('DOMMatrixReadOnly', class { m22 = 1 })
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: HTMLElement) { this.callback([{ target, contentRect: { width: target.offsetWidth, height: target.offsetHeight }, borderBoxSize: [{ inlineSize: target.offsetWidth, blockSize: target.offsetHeight }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver) }
    unobserve() {} disconnect() {}
  })
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const draw = async (over: Partial<FlowCanvasProps> = {}) => {
  await act(async () => { root.render(<FlowCanvas nodes={nodes} edges={edges} {...over} />) })
  // The public entry loads the real engine asynchronously.
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); expect(host.querySelectorAll('.react-flow__node')).toHaveLength(2) })
}
const key = (value: string, selector = '.react-flow__node') => act(() => {
  host.querySelector(selector)!.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }))
})

it('renders the supplied component and passes the node, selection and read-only state', async () => {
  await draw({ readOnly: true, NodeComponent: ({ node, selected, readOnly }) => <span data-custom={node.id}>{node.data.name}/{String(selected)}/{String(readOnly)}</span> })
  expect(host.querySelector('[data-custom="write"]')?.textContent).toBe('Write/true/true')
  expect(host.querySelector('[data-custom="check"]')?.textContent).toBe('Check/false/true')
})
it('draws default kind cards, the Run state slot and the rule word', async () => {
  await draw()
  expect(host.textContent).toContain('Implementer')
  expect(host.textContent).toContain('One seat')
  expect(host.textContent).toContain('Passed in 2m')
  expect(host.querySelector('[data-slot="flow-canvas-step"][data-state="done"]')).not.toBeNull()
  expect(host.textContent).toContain('ready')
})
it('reports engine selection and selected-node keyboard movement through controlled callbacks', async () => {
  const onNodesChange = vi.fn(), onSelectionChange = vi.fn()
  await draw({ onNodesChange, onSelectionChange })
  key('ArrowRight')
  expect(onNodesChange).toHaveBeenCalledWith([{ type: 'position', id: 'write', position: { x: 16, y: 0 } }])
  act(() => (host.querySelector('[data-id="check"].react-flow__node') as HTMLElement).click())
  expect(onNodesChange.mock.calls.some(([changes]) => changes.some((change: {type:string;id:string}) => change.type === 'select' && change.id === 'check'))).toBe(true)
  expect(onSelectionChange).toHaveBeenCalled()
})
it('Delete removes selected nodes and their incident edges', async () => {
  const onNodesChange = vi.fn(), onEdgesChange = vi.fn()
  await draw({ onNodesChange, onEdgesChange })
  key('Delete')
  expect(onNodesChange).toHaveBeenCalledWith([{ type: 'remove', id: 'write' }])
  expect(onEdgesChange).toHaveBeenCalledWith([{ type: 'remove', id: 'rule' }])
})
it('read-only preserves selection but refuses movement, deletion and connection affordances', async () => {
  const onNodesChange = vi.fn(), onEdgesChange = vi.fn(), onConnect = vi.fn()
  await draw({ readOnly: true, onNodesChange, onEdgesChange, onConnect })
  key('ArrowRight'); key('Delete')
  expect(onNodesChange).not.toHaveBeenCalled(); expect(onEdgesChange).not.toHaveBeenCalled(); expect(onConnect).not.toHaveBeenCalled()
  expect(host.querySelector('.react-flow__node.draggable')).toBeNull()
  expect(host.querySelector('.react-flow__handle.connectable')).toBeNull()
  expect(host.querySelector('[aria-label="Select tool"]')).toBeNull()
})
it('does not capture editing keys from controls inside a custom node', async () => {
  const onNodesChange = vi.fn()
  await draw({ onNodesChange, NodeComponent: () => <input aria-label="Step name" /> })
  key('Delete', 'input'); key('ArrowRight', 'input')
  expect(onNodesChange).not.toHaveBeenCalled()
})

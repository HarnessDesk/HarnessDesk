import { act, useState } from 'react'
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
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); expect(host.querySelectorAll('.react-flow__node')).toHaveLength(over.nodes?.length ?? nodes.length) })
}
const key = (value: string, selector = '.react-flow__node') => {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
  act(() => { host.querySelector(selector)!.dispatchEvent(event) })
  return event
}

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
  expect(onNodesChange).toHaveBeenCalledWith([{ type: 'position', id: 'write', position: { x: 16, y: 0 }, dragging: false }])
  act(() => (host.querySelector('[data-id="check"].react-flow__node') as HTMLElement).click())
  expect(onNodesChange.mock.calls.some(([changes]) => changes.some((change: {type:string;id:string}) => change.type === 'select' && change.id === 'check'))).toBe(true)
  expect(onSelectionChange).toHaveBeenCalled()
})
it('does not report the same selection again after a render', async () => {
  const onSelectionChange = vi.fn()
  await draw({ onSelectionChange })
  const reported = onSelectionChange.mock.calls.length
  await act(async () => { root.render(<FlowCanvas nodes={nodes} edges={edges} onSelectionChange={onSelectionChange} />) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(onSelectionChange).toHaveBeenCalledTimes(reported)
})
it('does not loop when a consumer stores the selection in state', async () => {
  let renders = 0
  const Consumer = () => {
    const [selection, setSelection] = useState<{ nodes: readonly string[]; edges: readonly string[] }>({ nodes: [], edges: [] })
    renders += 1
    return <div data-selection={selection.nodes.join(',')}><FlowCanvas nodes={nodes} edges={edges} onSelectionChange={next => setSelection(next)} /></div>
  }
  await act(async () => { root.render(<Consumer />) })
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); expect(host.querySelector('.react-flow__node')).not.toBeNull() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
  expect(renders).toBeLessThan(6)
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
it('prevents page keys from escaping a focused read-only step', async () => {
  await draw({ readOnly: true })
  for (const value of ['ArrowDown', 'Delete', 'Backspace']) expect(key(value).defaultPrevented).toBe(true)
})
it('does not capture editing keys from controls inside a custom node', async () => {
  const onNodesChange = vi.fn()
  await draw({ onNodesChange, NodeComponent: () => <input aria-label="Step name" /> })
  key('Delete', 'input'); key('ArrowRight', 'input')
  expect(onNodesChange).not.toHaveBeenCalled()
})
it('leaves menu items, radio controls and plaintext editors in a selected step in control of their keys', async () => {
  const onNodesChange = vi.fn(), onControlKey = vi.fn()
  await draw({ onNodesChange, NodeComponent: () => <>
    <div role="menuitem" tabIndex={0} onKeyDown={onControlKey}>Menu item</div>
    <input type="radio" aria-label="Choice" onKeyDown={onControlKey} />
    <div contentEditable="plaintext-only" suppressContentEditableWarning aria-label="Notes" onKeyDown={onControlKey}>Notes</div>
  </> })
  for (const [selector, keyName] of [['[role="menuitem"]', 'ArrowDown'], ['input[type="radio"]', 'ArrowDown'], ['[contenteditable="plaintext-only"]', 'ArrowRight']] as const) {
    const control = host.querySelector(selector) as HTMLElement
    act(() => control.focus())
    expect(key(keyName, selector).defaultPrevented, selector).toBe(false)
  }
  expect(onControlKey).toHaveBeenCalledTimes(3)
  expect(onNodesChange).not.toHaveBeenCalled()
})
it('describes read-only steps and rules without promising edits', async () => {
  await draw({ readOnly: true })
  const descriptions = [...host.querySelectorAll<HTMLElement>('[id*="node-desc"], [id*="edge-desc"]')].map(el => el.textContent ?? '').join(' ')
  expect(descriptions).toContain('Press Enter to select this step')
  expect(descriptions).toContain('Press Enter or Space to select this rule')
  expect(descriptions).not.toMatch(/move selected|remove/i)
  expect(host.querySelector('.react-flow__edge[data-id="rule"]')?.getAttribute('aria-label')).toBe('Write to Check: ready')
})
it('describes editable steps and rules and announces keyboard movement', async () => {
  await draw()
  const descriptions = [...host.querySelectorAll<HTMLElement>('[id*="node-desc"], [id*="edge-desc"]')].map(el => el.textContent ?? '').join(' ')
  expect(descriptions).toContain('Arrow keys move selected steps')
  expect(descriptions).toContain('Delete or Backspace to remove')
  expect(host.querySelector('.react-flow__edge[aria-label*="Write"][aria-label*="Check"]')).not.toBeNull()
  expect(host.querySelector('.react-flow__edge[data-id="rule"]')?.getAttribute('aria-label')).toBe('Write to Check: ready')
  key('ArrowRight')
  expect(host.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe('Moved Write to x 16, y 0.')
})
it('gives each mounted canvas unique DOM ids', async () => {
  await act(async () => { root.render(<><FlowCanvas nodes={nodes} edges={edges} /><FlowCanvas nodes={nodes} edges={edges} /></>) })
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); expect(host.querySelectorAll('.react-flow__node')).toHaveLength(4) })
  const ids = [...host.querySelectorAll<HTMLElement>('[id]')].map(element => element.id)
  expect(new Set(ids).size).toBe(ids.length)
})
it('moves focus to the next step after Delete and to the canvas when the last step is removed', async () => {
  const makeControlled = (initial: FlowCanvasNode[]) => () => {
    const [current, setCurrent] = useState(initial)
    return <FlowCanvas nodes={current} edges={[]} onNodesChange={changes => setCurrent(previous => previous.filter(node => !changes.some(change => change.type === 'remove' && change.id === node.id)))} />
  }
  const TwoSteps = makeControlled(nodes)
  await act(async () => { root.render(<TwoSteps />) })
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); expect(host.querySelectorAll('.react-flow__node')).toHaveLength(2) })
  const write = host.querySelector('.react-flow__node[data-id="write"]') as HTMLElement
  act(() => write.focus())
  key('Delete', '.react-flow__node[data-id="write"]')
  await vi.waitFor(() => expect(host.querySelector('.react-flow__node[data-id="check"]')).toBe(document.activeElement))

  const OneStep = makeControlled([nodes[0]!])
  await act(async () => { root.render(<OneStep />) })
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); expect(host.querySelectorAll('.react-flow__node')).toHaveLength(1) })
  const only = host.querySelector('.react-flow__node[data-id="write"]') as HTMLElement
  act(() => only.focus())
  key('Delete', '.react-flow__node[data-id="write"]')
  await vi.waitFor(() => expect(host.querySelector('[data-slot="flow-canvas"]')).toBe(document.activeElement))
})
it('re-centres the viewport when a different drawing replaces the current steps', async () => {
  await draw()
  const before = host.querySelector('.react-flow__viewport')!.getAttribute('style')
  const replacement: FlowCanvasNode[] = [{ id: 'elsewhere', position: { x: 3000, y: 900 }, data: { name: 'Elsewhere', kind: 'agent' } }]
  await draw({ nodes: replacement, edges: [] })
  const after = host.querySelector('.react-flow__viewport')!.getAttribute('style')
  expect(after).not.toBe(before)
})

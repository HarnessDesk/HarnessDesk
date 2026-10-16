import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as design from '../index'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

it('separates canvas tools and actions into labelled groups and preserves their controls', () => {
  expect(design.FlowCanvasToolbar).toBeTypeOf('function')
  const step = vi.fn(), start = vi.fn()
  act(() => root.render(<design.FlowCanvasToolbar actions={<design.Button onClick={start}>Start a Team</design.Button>}>
    <design.Button onClick={step}>Add step</design.Button>
  </design.FlowCanvasToolbar>))
  const tools = host.querySelector('[role="group"][aria-label="Flow tools"]')!
  const actions = host.querySelector('[role="group"][aria-label="Flow actions"]')!
  expect(tools.textContent).toBe('Add step')
  expect(actions.textContent).toBe('Start a Team')
  act(() => { tools.querySelector('button')!.click(); actions.querySelector('button')!.click() })
  expect(step).toHaveBeenCalledOnce()
  expect(start).toHaveBeenCalledOnce()
})

it('omits an absent actions plate instead of covering the other side of the canvas', () => {
  expect(design.FlowCanvasToolbar).toBeTypeOf('function')
  act(() => root.render(<design.FlowCanvasToolbar><design.Button disabled>Undo</design.Button></design.FlowCanvasToolbar>))
  expect(host.querySelector('[data-slot="flow-canvas-toolbar"]')).not.toBeNull()
  expect(host.querySelector('[aria-label="Flow actions"]')).toBeNull()
  expect(host.querySelector('button')!.disabled).toBe(true)
})

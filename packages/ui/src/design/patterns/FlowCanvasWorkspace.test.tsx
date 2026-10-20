import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as design from '../index'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('keeps the canvas, floating tools and card rail in separate labelled regions', () => {
  expect(design.FlowCanvasWorkspace).toBeTypeOf('function')
  act(() => root.render(<design.FlowCanvasWorkspace toolbar={<button>Step</button>} main={<div>Canvas</div>} rail={<div>Selected step</div>} onCloseRail={vi.fn()} />))
  expect(host.querySelector('main[aria-label="Flow editor"]')?.textContent).toContain('Canvas')
  expect(host.querySelector('aside[aria-label="Flow details"]')?.textContent).toContain('Selected step')
})
it('floats the rail over a narrow canvas and returns Escape and outside clicks to its owner', () => {
  expect(design.FlowCanvasWorkspace).toBeTypeOf('function')
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 700 } as DOMRect)
  const close = vi.fn()
  act(() => root.render(<design.FlowCanvasWorkspace main="Canvas" rail="Selected step" onCloseRail={close} />))
  const workspace = host.querySelector<HTMLElement>('[data-slot="flow-canvas-workspace"]')!
  expect(workspace.dataset.railFloating).toBe('true')
  act(() => workspace.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  act(() => host.querySelector<HTMLElement>('[data-slot="workbench-scrim"]')!.click())
  expect(close).toHaveBeenCalledTimes(2)
})

it('reserves the measured toolbar bottom for text content and updates when its controls wrap', () => {
  let toolbarHeight = 120
  const observers: { callback: () => void; targets: Element[]; disconnect: ReturnType<typeof vi.fn> }[] = []
  vi.stubGlobal('ResizeObserver', class {
    targets: Element[] = []
    disconnect = vi.fn()
    constructor(readonly callback: () => void) { observers.push(this) }
    observe(element: Element) { this.targets.push(element) }
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { width: 390, top: this.dataset.slot === 'flow-canvas-toolbar' ? 52 : 40,
      bottom: this.dataset.slot === 'flow-canvas-toolbar' ? 52 + toolbarHeight : 940,
      height: this.dataset.slot === 'flow-canvas-toolbar' ? toolbarHeight : 900 } as DOMRect
  })
  act(() => root.render(<design.FlowCanvasWorkspace onCloseRail={() => {}}
    toolbar={<design.FlowCanvasToolbar actions={<button>Start a Team</button>}><button>File</button></design.FlowCanvasToolbar>}
    main={<design.FlowCanvasContent><div>Source starts here</div></design.FlowCanvasContent>} />))
  const main = host.querySelector('main')!
  const toolbar = host.querySelector('[data-slot="flow-canvas-toolbar"]')!
  expect(main.style.getPropertyValue('--flow-toolbar-clearance')).toBe('132px')
  const observer = observers.find(one => one.targets.includes(toolbar))!
  expect(observer).toBeDefined()
  toolbarHeight = 176
  act(() => observer.callback())
  expect(main.style.getPropertyValue('--flow-toolbar-clearance')).toBe('188px')
  toolbarHeight = 36
  act(() => observer.callback())
  expect(main.style.getPropertyValue('--flow-toolbar-clearance')).toBe('48px')
  act(() => root.render(<design.FlowCanvasWorkspace onCloseRail={() => {}} main={<design.FlowCanvasContent>Source</design.FlowCanvasContent>} />))
  expect(main.style.getPropertyValue('--flow-toolbar-clearance')).toBe('0px')
  expect(observer.disconnect).toHaveBeenCalledOnce()
})

it('a normal-flow toolbar does not reserve its height a second time', () => {
  act(() => root.render(<design.FlowCanvasWorkspace onCloseRail={() => {}}
    toolbar={<design.FlowCanvasToolbar placement="bar"><button>File</button></design.FlowCanvasToolbar>}
    main={<design.FlowCanvasContent>Source</design.FlowCanvasContent>} />))
  expect(host.querySelector('main')!.style.getPropertyValue('--flow-toolbar-clearance')).toBe('0px')
  expect(host.querySelector('[data-slot="flow-canvas-toolbar"]')?.getAttribute('data-placement')).toBe('bar')
})

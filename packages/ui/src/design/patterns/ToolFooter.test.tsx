import { act, StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ToolFooterProvider, ToolFooterScope, ToolFooterPublisher, ToolFooterOutlet } from './ToolFooter'
import { ToolBody, ToolBodySections, ToolSection } from './ToolBody'
import { PanelFrame, PanelBody } from './InspectorPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })
it('selects only the visible owner and does not subscribe retained publishers', () => {
  const published = vi.fn()
  const Producer = ({ id }: { id: string }) => { published(id); return <ToolFooterScope id={id}><ToolFooterPublisher left={`${id} events`} right="Read from this work" /></ToolFooterScope> }
  const Selected = () => { const [id, setId] = useState<string | null>('one'); return <><button onClick={() => setId('two')}>Switch</button><button onClick={() => setId(null)}>Hide</button><ToolFooterOutlet id={id} /></> }
  act(() => root.render(<ToolFooterProvider><Producer id="one" /><Producer id="two" /><Selected /></ToolFooterProvider>))
  expect(container.querySelector('[data-slot="tool-footer"]')?.textContent).toContain('one events')
  act(() => container.querySelectorAll('button')[0]!.click())
  expect(container.querySelector('[data-slot="tool-footer"]')?.textContent).toContain('two events')
  expect(published).toHaveBeenCalledTimes(2)
  act(() => container.querySelectorAll('button')[1]!.click())
  expect(container.querySelector('[data-slot="tool-footer"]')).toBeNull()
})
it('keeps a replacement publisher when the former publisher cleans up', () => {
  const draw = (old: boolean) => act(() => root.render(<ToolFooterProvider>
    {old && <ToolFooterScope key="old" id="same"><ToolFooterPublisher left="Old" right="" /></ToolFooterScope>}
    <ToolFooterScope key="new" id="same"><ToolFooterPublisher left="Replacement" right="" /></ToolFooterScope>
    <ToolFooterOutlet id="same" />
  </ToolFooterProvider>))
  draw(true); draw(false)
  expect(container.querySelector('[data-slot="tool-footer"]')?.textContent).toBe('Replacement')
})
it('cleans up the last publisher and survives StrictMode effect replay', () => {
  const draw = (shown: boolean) => act(() => root.render(<StrictMode><ToolFooterProvider>
    {shown && <ToolFooterScope id="one"><ToolFooterPublisher left="12 events" right="Recorded" /></ToolFooterScope>}
    <ToolFooterOutlet id="one" />
  </ToolFooterProvider></StrictMode>))
  draw(true)
  expect(container.querySelectorAll('[data-slot="tool-footer"]')).toHaveLength(1)
  draw(false)
  expect(container.querySelector('[data-slot="tool-footer"]')).toBeNull()
})
it('falls back to content facts without a shell scope', () => {
  act(() => root.render(<ToolFooterPublisher left="12 events" right="Recorded" />))
  expect(container.querySelector('[data-slot="content-footer"]')?.textContent).toBe('12 eventsRecorded')
  expect(container.querySelector('[data-slot="bar"]')).toBeNull()
})
it('composes registered fact and plugin sections under one tool body and scroll owner', () => {
  act(() => root.render(<ToolBody><ToolBodySections><ToolBody><ToolSection label="Conversation">Facts</ToolSection></ToolBody><ToolBody><ToolSection label="Plugin"><PanelFrame><PanelBody>Recorded output</PanelBody></PanelFrame></ToolSection></ToolBody></ToolBodySections></ToolBody>))
  expect(container.querySelectorAll('[data-slot="tool-body"]')).toHaveLength(1)
  expect(container.querySelectorAll('[data-slot="tool-scroll"]')).toHaveLength(1)
  expect(container.querySelectorAll('[data-slot="tool-section"]')).toHaveLength(2)
  expect(container.querySelector('[data-slot="inspector-body"]')).toBeNull()
})

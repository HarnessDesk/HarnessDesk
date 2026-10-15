import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ToolBody, ToolFold, ToolRow, ToolSection } from './ToolBody'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const card = (label: string) => container.querySelector<HTMLElement>(`[data-slot="tool-section"][aria-label="${label}"]`)!

it('draws each section as a card with its summary in the header', () => {
  act(() => root.render(<ToolBody><ToolSection label="Seats" value={2}><ToolRow label="Alpha" value="Working" /></ToolSection></ToolBody>))
  expect(card('Seats').className).toContain('rounded-(--hd-panel-card-radius)')
  expect(card('Seats').querySelector('[data-slot="tool-section-value"]')?.textContent).toBe('2')
  expect(card('Seats').querySelector('[data-slot="tool-row"]')?.textContent).toBe('AlphaWorking')
})

it('a folding card keeps its value while folded and opens from its header', () => {
  act(() => root.render(<ToolSection label="Board" value="2 open" fold defaultOpen={false}><ToolRow label="#4 Retry" /></ToolSection>))
  const toggle = card('Board').querySelector<HTMLButtonElement>('[data-slot="tool-section-fold"]')!
  const body = card('Board').querySelector<HTMLElement>('[data-slot="tool-section-body"]')!
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(body.hidden).toBe(true)
  expect(card('Board').hasAttribute('data-folded')).toBe(true)
  expect(card('Board').querySelector('[data-slot="tool-section-value"]')?.textContent).toBe('2 open')
  act(() => toggle.click())
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(body.hidden).toBe(false)
  expect(toggle.getAttribute('aria-controls')).toBe(body.id)
})

it('a card that does not fold has no disclosure', () => {
  act(() => root.render(<ToolSection label="Run" value="Running">Facts</ToolSection>))
  expect(card('Run').querySelector('[data-slot="tool-section-fold"]')).toBeNull()
  expect(card('Run').hasAttribute('data-folded')).toBe(false)
})

it('a row carries one action, and the fold line hides the rest until asked', () => {
  const stop = vi.fn()
  act(() => root.render(<ToolSection label="Run">
    <ToolRow label="Build and review · round 2" action={<button type="button" onClick={stop}>Stop</button>} />
    <ToolFold label="All facts"><p>Rounds 2</p></ToolFold>
  </ToolSection>))
  act(() => container.querySelector<HTMLButtonElement>('[data-slot="tool-row"] button')!.click())
  expect(stop).toHaveBeenCalledOnce()
  const fold = container.querySelector<HTMLButtonElement>('[data-slot="tool-fold"] button')!
  expect(container.textContent).not.toContain('Rounds 2')
  act(() => fold.click())
  expect(fold.getAttribute('aria-expanded')).toBe('true')
  expect(container.textContent).toContain('Rounds 2')
})

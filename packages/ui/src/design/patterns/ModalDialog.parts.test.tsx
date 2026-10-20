import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { DialogContent, Dialog as DialogRoot } from '../ui/dialog'
import { Dialog, DialogBody, DialogHead } from './ModalDialog'
import modalSheet from './ModalDialog.module.css?raw'
import { SectionHead, Segmented } from './Settings'

/**
 * The dialog's regions are parts, and `Dialog` is drawn from them.
 *
 * A sheet that lays out its own body composes the same head and body a
 * `Dialog` does, so a dialog's title, description, inset and close control
 * are one drawing whichever is open.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

const sheet = (children: React.ReactNode) =>
  act(() =>
    root.render(
      <DialogRoot open>
        <DialogContent bleed showCloseButton={false} aria-label="Sheet">
          {children}
        </DialogContent>
      </DialogRoot>,
    ),
  )

it('draws one title, description, body inset, and footer anatomy', () => {
  act(() =>
    root.render(
      <Dialog
        title="Import between agents"
        icon={<span data-testid="leading-icon" />}
        description="From one agent to another"
        bodyPrelude={<span>First body item</span>}
        onClose={() => {}}
        footer={<><button type="button">Save</button><button type="button">Cancel</button></>}
        footerNavigation={<button type="button">Help</button>}
      >
        <SectionHead name="From" />
      </Dialog>,
    ),
  )
  const head = document.body.querySelector('[data-slot="dialog-head"]')
  expect(head?.querySelector('h2')?.textContent).toBe('Import between agents')
  const name = head?.querySelector('h2')?.className.split(/\s+/) ?? []
  expect(name).toEqual(expect.arrayContaining(['text-(length:--hd-text-lg)', 'leading-(--hd-line-lg)', 'font-semibold']))
  expect(name).not.toContain('leading-none')
  expect(head?.querySelector('[data-testid="leading-icon"]')).toBeNull()
  expect(head?.querySelector('button[aria-label="Close"]')).not.toBeNull()
  expect(head?.querySelector('[data-slot="dialog-description"]')?.textContent).toBe('From one agent to another')
  expect(head?.hasAttribute('data-lines')).toBe(true)
  const body = document.body.querySelector('[data-slot="modal-dialog-body"]')
  expect(body?.getAttribute('data-layout')).toBe('form')
  expect(body?.firstElementChild?.getAttribute('data-slot')).toBe('dialog-body-prelude')
  expect(body?.getAttribute('style')).toBeNull()
  expect(modalSheet).toMatch(/\.body\s*\{[^}]*padding:\s*var\(--hd-inset-dialog\)/s)
  expect(modalSheet).not.toMatch(/\.flush\s*>/)
  // A form body is a form: a section head inside it is the group's legend.
  expect(body?.querySelector('[data-slot="fieldset-legend"]')).not.toBeNull()
  const footer = document.body.querySelector('[data-slot="dialog-footer"]')
  expect(document.body.querySelectorAll('[data-slot="dialog-footer"]')).toHaveLength(1)
  expect(footer?.querySelector('[data-slot="dialog-footer-navigation"]')?.textContent).toBe('Help')
  const actions = footer?.querySelector('[data-slot="dialog-footer-actions"]')
  expect([...actions?.querySelectorAll('button') ?? []].map(button => button.textContent)).toEqual(['Save', 'Cancel'])
  expect(modalSheet).toMatch(/\.footer\s*\{[^}]*min-height:\s*calc\(var\(--hd-inset-dialog\)\s*\+\s*var\(--hd-inset-dialog\)\s*\+\s*var\(--hd-btn-h\)\s*\+\s*var\(--hd-border-width\)\)/s)
  expect(modalSheet).toMatch(/\.footerActions\s*\{[^}]*flex-direction:\s*row-reverse/s)
})

it('takes every dialog width from its named size scale', () => {
  const sizes = [
    ['sm', 'w-[min(460px,100%)]'],
    ['md', 'w-[min(520px,100%)]'],
    ['lg', 'w-[min(560px,100%)]'],
    ['xl', 'w-[min(620px,100%)]'],
    ['wide', 'w-[min(860px,100%)]'],
  ] as const
  for (const [size, width] of sizes) {
    act(() => root.render(<Dialog title={`Size ${size}`} size={size} onClose={() => {}} />))
    const surface = document.body.querySelector('[role="dialog"]')
    expect(surface?.className, `size=${size}`).toContain(width)
  }
})

it('holds a head with lines under its name to their top, with the aside on the name line', () => {
  sheet(
    <DialogHead icon={<span data-testid="tile" />} title="code-review" aside={<span data-testid="kind">Skill</span>}>
      <span data-testid="line">/code-review</span>
    </DialogHead>,
  )
  const head = document.body.querySelector('[data-slot="dialog-head"]')
  expect(head?.hasAttribute('data-lines')).toBe(true)
  const title = head?.querySelector('h2')
  expect(title?.textContent).toBe('code-review')
  // The aside shares the name's line; the lines sit under it, in the heading.
  expect(title?.parentElement?.querySelector('[data-testid="kind"]')).not.toBeNull()
  expect(title?.parentElement?.parentElement?.querySelector('[data-testid="line"]')).not.toBeNull()
  expect(head?.querySelector('button[aria-label="Close"]')).not.toBeNull()
  expect(head?.querySelector('[data-testid="tile"]')).toBeNull()
  expect(modalSheet).toMatch(/\.header\[data-lines\]\s*\{[^}]*align-items:\s*flex-start/s)
  expect(head?.querySelector('[data-slot="dialog-description"]')?.className).toContain('text-(--hd-secondary-foreground)')
  expect(head?.querySelector('[data-slot="dialog-description"]')?.className).toContain('text-(length:--hd-text-sm)')
})

it('keeps consequence sentences and opaque identifiers readable while the title remains a truncated name', () => {
  const title = 'A long subject name that still belongs on one title line'
  const consequence = 'Conversations and branches stay. Reopening a conversation recreates its worktree.'
  const identifier = `mcp-${'resource'.repeat(30)}`
  sheet(<DialogHead title={title}>{consequence} {identifier}</DialogHead>)
  const head = document.body.querySelector('[data-slot="dialog-head"]')!
  const description = head.querySelector('[data-slot="dialog-description"]')!
  expect(description.textContent).toBe(`${consequence} ${identifier}`)
  expect(head.querySelector('h2')?.classList.contains('truncate')).toBe(true)
  expect(head.querySelector('h2')?.getAttribute('title')).toBe(title)
  const rule = /\.description\s*\{([^}]*)\}/s.exec(modalSheet)?.[1] ?? ''
  expect(rule).toMatch(/white-space:\s*normal/)
  expect(rule).toMatch(/overflow-wrap:\s*anywhere/)
  expect(rule).toMatch(/max-height:\s*min\(round\(down,\s*8vh,\s*var\(--hd-line-sm\)\),\s*calc\(var\(--hd-line-sm\)\s*\*\s*4\)\)/)
  expect(rule).toMatch(/overflow-y:\s*auto/)
  expect(rule).not.toMatch(/(?:overflow:\s*hidden|text-overflow:\s*ellipsis|white-space:\s*nowrap)/)
})

it('makes only an overflowing description tabbable and remeasures text and viewport changes', () => {
  const observers: { check: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn()
    disconnect = vi.fn()
    constructor(callback: ResizeObserverCallback) { observers.push({ check: () => callback([], this as unknown as ResizeObserver), observe: this.observe, disconnect: this.disconnect }) }
  })
  try {
    sheet(<DialogHead title="Chats folder">Short consequence.</DialogHead>)
    const description = document.body.querySelector<HTMLElement>('[data-slot="dialog-description"]')!
    expect(description.hasAttribute('tabindex')).toBe(false)
    let content = 120, height = 40
    Object.defineProperties(description, { scrollHeight: { get: () => content }, clientHeight: { get: () => height } })
    act(() => window.dispatchEvent(new Event('resize')))
    expect(description.tabIndex).toBe(0)
    const first = observers.at(-1)!
    expect(first.observe).toHaveBeenCalledWith(description)
    height = 120
    act(() => first.check())
    expect(description.hasAttribute('tabindex')).toBe(false)
    height = 40
    act(() => window.dispatchEvent(new Event('resize')))
    expect(description.tabIndex).toBe(0)
    content = 40
    // A changed string must be measured even when the constrained box has not resized.
    sheet(<DialogHead title="Chats folder">A changed short consequence.</DialogHead>)
    expect(description.hasAttribute('tabindex')).toBe(false)
    expect(first.disconnect).toHaveBeenCalledOnce()
  } finally { vi.unstubAllGlobals() }
})

it('disconnects removed descriptions and ignores their queued observer callbacks', () => {
  const observers: { check: () => void; disconnect: ReturnType<typeof vi.fn> }[] = []
  const remove = vi.spyOn(window, 'removeEventListener')
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn()
    disconnect = vi.fn()
    constructor(callback: ResizeObserverCallback) { observers.push({ check: () => callback([], this as unknown as ResizeObserver), disconnect: this.disconnect }) }
  })
  try {
    sheet(<DialogHead title="Chats folder"><span>Long refusal</span></DialogHead>)
    const old = document.body.querySelector<HTMLElement>('[data-slot="dialog-description"]')!
    Object.defineProperties(old, { scrollHeight: { value: 120 }, clientHeight: { value: 40 } })
    act(() => window.dispatchEvent(new Event('resize')))
    expect(old.tabIndex).toBe(0)
    const first = observers.at(-1)!
    sheet(<DialogHead title="Chats folder" />)
    expect(first.disconnect).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function))
    sheet(<DialogHead title="Chats folder">Short consequence.</DialogHead>)
    const fresh = document.body.querySelector<HTMLElement>('[data-slot="dialog-description"]')!
    act(() => first.check())
    expect(fresh.hasAttribute('tabindex')).toBe(false)
    const last = observers.at(-1)!
    act(() => root.render(null))
    expect(last.disconnect).toHaveBeenCalledOnce()
  } finally { remove.mockRestore(); vi.unstubAllGlobals() }
})

it('keeps a reading body out of the form grammar', () => {
  sheet(
    <DialogBody layout="reading">
      <SectionHead name="Frontmatter" />
    </DialogBody>,
  )
  const body = document.body.querySelector('[data-slot="modal-dialog-body"]')
  expect(body?.getAttribute('data-layout')).toBe('reading')
  // Not a form: a section head keeps its page shape rather than a legend's.
  expect(body?.querySelector('[data-slot="fieldset-legend"]')).toBeNull()
  expect(body?.querySelector('[data-slot="section-name"]')).not.toBeNull()
})

it('never lets a second press empty a segmented control', () => {
  const onChange = vi.fn()
  act(() =>
    root.render(
      <Segmented
        label="How to show the definition"
        value="rendered"
        options={[
          { value: 'rendered', label: 'Rendered' },
          { value: 'source', label: 'Source' },
        ]}
        onChange={onChange}
      />,
    ),
  )
  const [rendered, source] = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
  act(() => rendered?.click())
  expect(onChange).not.toHaveBeenCalled()
  act(() => source?.click())
  expect(onChange).toHaveBeenCalledWith('source')
})

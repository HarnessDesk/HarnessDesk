import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { DialogContent, Dialog as DialogRoot } from '../ui/dialog'
import { Dialog, DialogBody, DialogHead, DialogSubhead } from './ModalDialog'
import modalSheet from './ModalDialog.module.css?raw'
import { SectionHead, Segmented } from './Settings'

/**
 * The dialog's regions are parts, and `Dialog` is drawn from them.
 *
 * A sheet that lays out its own body — the skill sheet, two lanes and a bar —
 * composes the same head, subhead and body a `Dialog` does, so a dialog's
 * name, its inset and the rule under it are one drawing whichever is open.
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

it('draws a Dialog from the same head, subhead and body parts a sheet composes', () => {
  act(() =>
    root.render(
      <Dialog title="Import between agents" subhead="From one agent to another" onClose={() => {}}>
        <SectionHead name="From" />
      </Dialog>,
    ),
  )
  const head = document.body.querySelector('[data-slot="dialog-head"]')
  expect(head?.querySelector('h2')?.textContent).toBe('Import between agents')
  // The name is the subject step: 14/21, medium — said as utilities so they
  // replace the title primitive's `text-base leading-none` rather than tie.
  const name = head?.querySelector('h2')?.className.split(/\s+/) ?? []
  expect(name).toEqual(expect.arrayContaining(['text-(length:--hd-text)', 'leading-(--hd-line)', 'font-medium']))
  expect(name).not.toContain('leading-none')
  expect(head?.querySelector('button[aria-label="Close"]')).not.toBeNull()
  // A head with nothing under its name keeps the one-line shape.
  expect(head?.hasAttribute('data-lines')).toBe(false)
  expect(document.body.querySelector('[data-slot="dialog-subhead"]')?.textContent).toBe('From one agent to another')
  const body = document.body.querySelector('[data-slot="modal-dialog-body"]')
  expect(body?.getAttribute('data-layout')).toBe('form')
  // A form body is a form: a section head inside it is the group's legend.
  expect(body?.querySelector('[data-slot="fieldset-legend"]')).not.toBeNull()
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
  expect(modalSheet).toMatch(/\.header\[data-lines\]\s*\{[^}]*align-items:\s*flex-start/s)
})

it('keeps a reading body out of the form grammar, and a subhead outside the scroll', () => {
  sheet(
    <>
      <DialogSubhead className="justify-between">
        <span>Rendered</span>
      </DialogSubhead>
      <DialogBody layout="reading">
        <SectionHead name="Frontmatter" />
      </DialogBody>
    </>,
  )
  const body = document.body.querySelector('[data-slot="modal-dialog-body"]')
  expect(body?.getAttribute('data-layout')).toBe('reading')
  // Not a form: a section head keeps its page shape rather than a legend's.
  expect(body?.querySelector('[data-slot="fieldset-legend"]')).toBeNull()
  expect(body?.querySelector('[data-slot="section-name"]')).not.toBeNull()
  const subhead = document.body.querySelector('[data-slot="dialog-subhead"]')
  expect(subhead?.className).toContain('justify-between')
  expect(subhead?.contains(body ?? null)).toBe(false)
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

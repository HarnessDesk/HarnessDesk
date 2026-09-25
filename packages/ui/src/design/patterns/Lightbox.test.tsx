import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { Lightbox } from './Lightbox'

const images = [
  { name: 'First image', url: 'data:image/png;base64,AA==' },
  { name: 'Second image', url: 'data:image/png;base64,AQ==' },
] as const

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(() => root.unmount())
  document.body.innerHTML = ''
})

const frame = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50))
})

const Harness = ({ onClose = () => {} }: { onClose?: () => void }) => {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open image</button>
      {open && <Lightbox images={images} index={0} onClose={() => { setOpen(false); onClose() }} />}
    </>
  )
}

const open = async (onClose = () => {}) => {
  await act(() => root.render(<Harness onClose={onClose} />))
  const opener = host.querySelector('button') as HTMLButtonElement
  opener.focus()
  await act(() => opener.click())
  await frame()
  return opener
}

const close = () => document.querySelector<HTMLButtonElement>('[data-lightbox] [data-slot="dialog-close"]')

it('moves focus to the safe close action and returns it to the opener', async () => {
  const opener = await open()
  expect(close()).not.toBeNull()
  expect(document.activeElement).toBe(close())

  await act(() => close()!.click())
  await frame()
  expect(document.activeElement).toBe(opener)
})

it('dismisses through the Base UI backdrop and only the topmost Escape handler', async () => {
  const onClose = vi.fn()
  await open(onClose)
  const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')
  expect(overlay).not.toBeNull()

  await act(() => {
    overlay?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    overlay?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    overlay?.click()
  })
  await frame()
  expect(onClose).toHaveBeenCalledTimes(1)

  await open(onClose)
  await act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await frame()
  expect(onClose).toHaveBeenCalledTimes(2)
})

it('walks the gallery with canonical actions and arrow keys', async () => {
  await open()
  expect(document.querySelector('img')?.getAttribute('alt')).toBe('First image')

  await act(() => (document.querySelector('[aria-label="Next image"]') as HTMLButtonElement).click())
  expect(document.querySelector('img')?.getAttribute('alt')).toBe('Second image')

  // From where the focus is — inside the sheet — as a person presses it.
  await act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
  expect(document.querySelector('img')?.getAttribute('alt')).toBe('First image')
})

it('is the dialog, drawn by the dialog: its surface, its close, and the name as its title', async () => {
  await open()
  const sheet = document.querySelector<HTMLElement>('[data-lightbox]')
  // The dialog's own surface, not a sheet the viewer made transparent and redrew.
  expect(sheet?.getAttribute('data-slot')).toBe('dialog-content')
  expect(sheet?.className).toContain('bg-popover')
  expect(sheet?.className).not.toContain('bg-transparent')
  // The dialog's close — the one every dialog wears — named for a reader.
  expect(close()?.textContent).toContain('Close')
  // Named by its title and described by its facts, where a reader looks.
  const title = document.querySelector('[data-slot="dialog-title"]')
  expect(title?.textContent).toBe('First image')
  expect(title?.classList.contains('sr-only')).toBe(false)
  expect(sheet?.getAttribute('aria-labelledby')).toBe(title?.id)
  expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toContain('1 of 2')
})

it('steps the gallery with the floating control every button over content wears', async () => {
  await open()
  for (const name of ['Previous image', 'Next image']) {
    const step = document.querySelector<HTMLElement>(`[aria-label="${name}"]`)
    expect(step?.className).toContain('rounded-full')
    expect(step?.className).toContain('bg-(--hd-card)')
  }
  await act(() => (document.querySelector('[aria-label="Next image"]') as HTMLButtonElement).click())
  expect(document.querySelector('[data-slot="dialog-title"]')?.textContent).toBe('Second image')
  expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toContain('2 of 2')
})

it('draws one picture without steps or a count', async () => {
  await act(() => root.render(<Lightbox images={[images[0]]} index={0} onClose={() => {}} />))
  await frame()
  expect(document.querySelector('[aria-label="Next image"]')).toBeNull()
  expect(document.querySelector('[aria-label="Previous image"]')).toBeNull()
  expect(document.querySelector('[data-slot="dialog-description"]')?.textContent ?? '').not.toContain('of')
})

it('answers the arrows from inside the sheet even when the key never reaches the window', async () => {
  await open()
  const stop = (event: Event): void => event.stopPropagation()
  document.addEventListener('keydown', stop)
  try {
    await act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(document.querySelector('[data-slot="dialog-title"]')?.textContent).toBe('Second image')
  } finally {
    document.removeEventListener('keydown', stop)
  }
})

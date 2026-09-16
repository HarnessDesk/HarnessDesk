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

it('moves focus to the safe close action and returns it to the opener', async () => {
  const opener = await open()
  expect(document.activeElement).toBe(document.querySelector('[aria-label="Close"]'))

  await act(() => (document.querySelector('[aria-label="Close"]') as HTMLButtonElement).click())
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

  await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' })))
  expect(document.querySelector('img')?.getAttribute('alt')).toBe('First image')
})

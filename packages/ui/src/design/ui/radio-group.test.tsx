import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { Button } from './button'
import { Card } from './card'
import { RadioGroup, RadioGroupItem } from './radio-group'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('keeps default radio styling and glyphs, and submits its selected value', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<form><RadioGroup name="theme" defaultValue="light" aria-label="Theme">
      <RadioGroupItem value="light" aria-label="Light" />
      <RadioGroupItem value="dark" aria-label="Dark" />
    </RadioGroup></form>))
    const radios = [...host.querySelectorAll<HTMLElement>('[role="radio"]')]
    expect(host.querySelector('[role="radiogroup"]')?.className).toBe('grid gap-2')
    expect(radios[0]!.className).toContain('aspect-square size-4')
    expect(radios.every(radio => radio.getAttribute('data-slot') === 'radio-group-item')).toBe(true)
    expect(radios[0]!.querySelector('[data-slot="radio-group-indicator"]')).not.toBeNull()
    await act(async () => radios[1]!.click())
    expect(new FormData(host.querySelector('form')!).get('theme')).toBe('dark')
  } finally { act(() => root.unmount()); host.remove() }
})

it('composes a choice button with its children, ref, visual classes and form value', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const ref = createRef<HTMLButtonElement>()
  try {
    await act(async () => root.render(<form><RadioGroup variant="choice" name="theme" defaultValue="light" aria-label="Theme">
      <RadioGroupItem variant="choice" nativeButton ref={ref} value="light" render={<Button variant="choice" size="row" />}>
        <span>Light preview</span>
      </RadioGroupItem>
    </RadioGroup></form>))
    const radio = host.querySelector<HTMLButtonElement>('[role="radio"]')!
    expect(ref.current).toBe(radio)
    expect(radio.tagName).toBe('BUTTON')
    expect(radio.textContent).toBe('Light preview')
    expect(radio.className).toContain('data-[on]:bg-(--hd-active)')
    expect(radio.className).not.toContain('aspect-square')
    expect(host.querySelector('[role="radiogroup"]')?.className).toBe('')
    expect(radio.querySelector('[data-slot="radio-group-indicator"]')).toBeNull()
    expect(new FormData(host.querySelector('form')!).get('theme')).toBe('light')
  } finally { act(() => root.unmount()); host.remove() }
})


it('preserves delegated swatch and card identities through radio keyboard selection', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<form><RadioGroup variant="choice" name="appearance" defaultValue="swatch" aria-label="Appearance">
      <RadioGroupItem variant="choice" nativeButton value="swatch" aria-label="Violet" render={<Button type="button" variant="ghost" size="icon-circle" swatch="rgb(124,58,237)" />} />
      <RadioGroupItem variant="choice" nativeButton value="card" aria-label="Preview" render={<Card as="button" type="button" />}>Preview</RadioGroupItem>
      <RadioGroupItem variant="choice" value="plain" aria-label="Plain">Plain</RadioGroupItem>
    </RadioGroup></form>))
    const radios = [...host.querySelectorAll<HTMLElement>('[role="radio"]')]
    const [swatch, card, plain] = radios
    expect(swatch!.getAttribute('data-slot')).toBe('button')
    expect(swatch!.hasAttribute('data-swatch')).toBe(true)
    expect(swatch!.style.getPropertyValue('--swatch')).toBe('rgb(124,58,237)')
    expect(card!.getAttribute('data-slot')).toBe('card')
    expect(plain!.getAttribute('data-slot')).toBe('radio-group-item')
    expect(radios.filter(radio => radio.tabIndex === 0)).toEqual([swatch])
    act(() => swatch!.focus())
    await act(async () => {
      swatch!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      swatch!.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    })
    expect(document.activeElement).toBe(card)
    expect(card!.getAttribute('aria-checked')).toBe('true')
    expect(new FormData(host.querySelector('form')!).get('appearance')).toBe('card')
    await act(async () => swatch!.click())
    expect(swatch!.getAttribute('aria-checked')).toBe('true')
    expect(new FormData(host.querySelector('form')!).get('appearance')).toBe('swatch')
  } finally { act(() => root.unmount()); host.remove() }
})

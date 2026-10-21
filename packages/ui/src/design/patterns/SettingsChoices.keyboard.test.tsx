import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { AccentChoices, RingChoices } from './SettingsChoices'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it.each(['accent', 'ring'] as const)('%s choices have one tab stop and standard radio keyboard selection', async kind => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const values = ['blue', 'green', 'violet'] as const
  const Choices = () => {
    const [value, change] = useState<(typeof values)[number]>('green')
    return kind === 'accent'
      ? <AccentChoices value={value} items={values.map(value => ({ value, label: value, swatch: 'var(--hd-accent)' }))} change={change} />
      : <RingChoices value={value} values={values} mark="A" change={change} />
  }
  const radios = () => [...host.querySelectorAll<HTMLElement>('[role="radio"]')]
  const selected = () => radios().find(radio => radio.getAttribute('aria-checked') === 'true')!
  const key = async (key: string) => {
    await act(async () => {
      const target = document.activeElement as HTMLElement
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
      // jsdom has no native button activation default for Space.
      if (key === ' ') target.click()
    })
  }
  try {
    await act(async () => root.render(<Choices />))
    expect(radios().filter(radio => radio.tabIndex === 0)).toEqual([selected()])
    act(() => selected().focus())
    for (const [pressed, value] of [['ArrowRight', 'violet'], ['Home', 'violet'], ['End', 'violet'], ['ArrowLeft', 'green'], ['ArrowUp', 'blue'], ['ArrowDown', 'green']] as const) {
      await key(pressed)
      expect(selected().getAttribute('aria-label')).toBe(value)
      expect(document.activeElement).toBe(selected())
    }
    act(() => radios()[0]!.focus())
    await key(' ')
    expect(selected().getAttribute('aria-label')).toBe('blue')
    await act(async () => { radios()[2]!.focus(); radios()[2]!.click() })
    expect(selected().getAttribute('aria-label')).toBe('violet')
    expect(radios().filter(radio => radio.tabIndex === 0)).toEqual([selected()])
  } finally { act(() => root.unmount()); host.remove() }
})

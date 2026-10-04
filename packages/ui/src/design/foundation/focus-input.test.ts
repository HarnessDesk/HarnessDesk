import { expect, it } from 'vitest'
import { installFocusInput } from './focus-input'

it('keeps pointer focus quiet across dismissal and enables the ring for navigation', () => {
  const scene = document.implementation.createHTMLDocument()
  const stop = installFocusInput(scene)
  scene.dispatchEvent(new Event('pointerdown'))
  expect(scene.documentElement.dataset['focusInput']).toBe('pointer')
  for (const key of ['Escape', 'Shift', 'Control', 'Alt', 'Meta']) {
    scene.dispatchEvent(new KeyboardEvent('keydown', { key }))
    expect(scene.documentElement.dataset['focusInput']).toBe('pointer')
  }
  for (const key of ['Tab', 'ArrowDown', 'Home', 'ContextMenu', 'Enter']) {
    scene.dispatchEvent(new KeyboardEvent('keydown', { key }))
    expect(scene.documentElement.dataset['focusInput']).toBe('keyboard')
    scene.dispatchEvent(new Event('pointerdown'))
    expect(scene.documentElement.dataset['focusInput']).toBe('pointer')
  }
  stop()
  scene.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
  expect(scene.documentElement.hasAttribute('data-focus-input')).toBe(false)
})

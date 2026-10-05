/** The document's ring follows navigation, including programmatic focus restores. */
export const installFocusInput = (owner: Document): (() => void) => {
  const root = owner.documentElement
  const set = (input: 'pointer' | 'keyboard') => {
    if (root.dataset['focusInput'] !== input) root.dataset['focusInput'] = input
  }
  const pointer = () => set('pointer')
  const keyboard = (event: KeyboardEvent) => {
    // Escape dismisses a surface; it does not turn a pointer return target
    // into a keyboard destination. Navigation or activation does.
    if (['Escape', 'Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return
    set('keyboard')
  }
  owner.addEventListener('pointerdown', pointer, true)
  owner.addEventListener('keydown', keyboard, true)
  return () => {
    owner.removeEventListener('pointerdown', pointer, true)
    owner.removeEventListener('keydown', keyboard, true)
    root.removeAttribute('data-focus-input')
  }
}

// All product, preview and catalog surfaces enter through the design facade.
const stop = typeof document === 'undefined' ? undefined : installFocusInput(document)
if (import.meta.hot) import.meta.hot.dispose(() => stop?.())

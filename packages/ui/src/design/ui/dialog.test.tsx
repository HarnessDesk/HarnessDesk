import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { compile } from 'tailwindcss'
import themeSheet from 'tailwindcss/theme.css?raw'
import utilitiesSheet from 'tailwindcss/utilities.css?raw'
import { afterEach, beforeEach, expect, it } from 'vitest'

import dialogSheet from '../primitives/Dialog.module.css?raw'
import shadcnSheet from '../../styles/shadcn.css?raw'
import { AlertDialogFooter } from './alert-dialog'
import { DialogFooter } from './dialog'

/**
 * Where a design-system footer's buttons go — pinned before a screen adopts
 * one.
 *
 * Every footer in this app is `row-reverse`, so the button written first
 * paints rightmost: `Dialog.module.css`'s `.footer` behind the app's dialogs,
 * the `footer` prop on `Dialog` that says to write the confirming action
 * first, and `ConfirmDialog`, which had it the other way round until #200.
 * The shadcn layer's `DialogFooter` was still the stock `flex-row
 * justify-end`, which paints in written order — so the first surface to write
 * a footer the app's way would have painted its proceeding action on the
 * left, and nothing would have failed. Nothing renders `DialogFooter` on any
 * branch today; that is why this was cheap to fix and why only a test keeps
 * it fixed.
 *
 * jsdom does no layout, so "rightmost" is read the way
 * `ConfirmDialog.test.tsx` reads it — from the two things that decide it, the
 * tree order and the computed `flex-direction` — rather than from either
 * alone.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The utilities the app really ships, compiled for the classes the component
 * really emits.
 *
 * A Tailwind utility is not a file a test can import: it is generated on
 * demand from the candidates found in the source. So Tailwind's own compiler
 * runs here over the two entry sheets `styles/shadcn.css` imports — the same
 * two files, read through the same specifiers — for the class list the
 * rendered footer is wearing. Asserting the class string instead would pass
 * against a stylesheet that never loaded, and would pass against
 * `justify-end`, which changes which end a reversed row packs to without
 * changing `flex-direction`.
 */
const ENTRY_SHEETS = ['tailwindcss/theme.css', 'tailwindcss/utilities.css'] as const

/** Compiles the utilities for `classes` and puts them in the document. */
const applyUtilities = async (classes: readonly string[]): Promise<void> => {
  const compiler = await compile([themeSheet, utilitiesSheet].join('\n'), { base: '/' })
  const style = document.createElement('style')
  style.textContent = compiler.build([...classes])
  document.head.append(style)
}

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
  for (const style of [...document.head.querySelectorAll('style')]) style.remove()
})

/**
 * A flex row's children, left to right, as a browser paints them: the tree
 * order, reversed by `row-reverse`, with no `order` re-sorting any child. The
 * `display` check is the guard that the sheet arrived — without it the footer
 * is a block, and every row would read as its tree order.
 */
const paintedLeftToRight = (row: HTMLElement): HTMLElement[] => {
  const style = getComputedStyle(row)
  expect(style.display).toBe('flex')
  const children = [...row.children] as HTMLElement[]
  for (const child of children) expect(getComputedStyle(child).order || '0').toBe('0')
  if (style.flexDirection === 'row-reverse') return children.reverse()
  expect(style.flexDirection || 'row').toBe('row')
  return children
}

it.each([
  { name: 'DialogFooter', Footer: DialogFooter, slot: 'dialog-footer' },
  // #200 aligned this one; it is here so the pair cannot drift apart again.
  { name: 'AlertDialogFooter', Footer: AlertDialogFooter, slot: 'alert-dialog-footer' },
])('paints the action written first on the right: $name', async ({ Footer, slot }) => {
  act(() =>
    root.render(
      <Footer>
        <button type="button">Delete</button>
        <button type="button">Keep</button>
      </Footer>,
    ),
  )
  const footer = container.querySelector<HTMLElement>(`[data-slot="${slot}"]`)
  if (!footer) throw new Error(`no ${slot} rendered`)
  // Compiled from what this footer is wearing, so the test cannot drift from
  // the component by asserting utilities it stopped emitting.
  await applyUtilities(footer.className.split(/\s+/).filter(Boolean))

  const [left, right] = paintedLeftToRight(footer)
  expect(left?.textContent).toBe('Keep')
  expect(right?.textContent).toBe('Delete')

  /* A reversed row packs to the right on its own, which is why the fix drops
     `justify-end` rather than keeping it. Adding it back puts the same two
     buttons at the wrong end of the dialog under the same `flex-direction`,
     so its absence is asserted rather than assumed. */
  expect(getComputedStyle(footer).justifyContent || 'normal').toBe('normal')
})

it('compiles from the utility source the app actually ships', () => {
  /* The one thing above that could quietly become a copy: if the app's bridge
     changes where its utilities come from, the sheet compiled here is a
     different sheet from the one on screen, and the test above would be
     pinning nothing. */
  for (const entry of ENTRY_SHEETS) expect(shadcnSheet).toContain(`@import '${entry}';`)
})

it('agrees with the footer the app draws today', () => {
  /* `Dialog.module.css`'s `.footer` is the live one — every dialog in the app
     is the `Dialog` primitive, and `ConfirmDialog.test.tsx` computes this
     same direction from the real sheet. Read as text here because the rule
     being pinned is that the two idioms answer the question the same way. */
  expect(dialogSheet).toMatch(/\.footer\s*\{[^}]*flex-direction:\s*row-reverse/)
})

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { ConfirmDialog } from './ConfirmDialog'

/**
 * Where a confirm's two buttons go, and the order Tab takes them in — pinned.
 *
 * The footer is `row-reverse`, so the button written first paints rightmost
 * and is the first of the two in the tab order. ConfirmDialog once wrote Keep
 * first: every confirm in the app painted the verb for leaving things alone
 * where the pointer goes to proceed, while the component's comment and the
 * footer's both said otherwise. Nothing failed, because nothing looked.
 *
 * jsdom does no layout, so "rightmost" is read from the two things that decide
 * it — the tree order, and the footer's computed `flex-direction` from the
 * real stylesheet — rather than from either alone: a swap in the markup and a
 * change to the sheet each fail here on their own.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Props = ComponentProps<typeof ConfirmDialog>

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
})

/** Opens a confirm and returns its surface, which Base UI portals to the body. */
const open = (props: Partial<Props> = {}): HTMLElement => {
  act(() =>
    root.render(
      <ConfirmDialog
        title="Delete conversation"
        confirmLabel="Delete"
        onConfirm={() => {}}
        onCancel={() => {}}
        {...props}
      >
        The transcript goes, and the agent forgets it.
      </ConfirmDialog>,
    ),
  )
  const surface = document.querySelector<HTMLElement>('[role="alertdialog"]')
  if (!surface) throw new Error('the confirm did not open')
  return surface
}

const button = (surface: HTMLElement, label: string): HTMLButtonElement => {
  const found = [...surface.querySelectorAll('button')].find((each) => each.textContent === label)
  if (!found) throw new Error(`no "${label}" button`)
  return found
}

/**
 * A flex row's children, left to right, as a browser paints them: the tree
 * order, reversed by `row-reverse`, with no `order` re-sorting any child. The
 * `display` check is the guard that the sheet arrived — stubbed, the footer
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

/**
 * The order Tab visits a scope's controls in, by HTML's rule: positive
 * `tabindex` first and ascending, then everything at 0 in tree order, with
 * disabled controls and `tabindex="-1"` passed over. jsdom does not move focus
 * on Tab, so the rule is applied here rather than simulated.
 */
const tabOrder = (scope: HTMLElement): HTMLElement[] => {
  const focusable = [
    ...scope.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]'),
  ].filter((each) => each.tabIndex >= 0 && !(each as HTMLButtonElement).disabled)
  return [
    ...focusable.filter((each) => each.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex),
    ...focusable.filter((each) => each.tabIndex === 0),
  ]
}

it.each([
  // RemoveWorktree, the removals in Settings, signing out: the red verb and "Keep".
  { shape: 'a destructive confirm', props: {}, proceed: 'Delete', stay: 'Keep' },
  // OptionConfirm: the ordinary tone, with a better verb for staying put.
  {
    shape: 'a default-tone confirm with its own verb for staying',
    props: { tone: 'default', confirmLabel: 'Turn on Max mode', cancelLabel: 'Not now' },
    proceed: 'Turn on Max mode',
    stay: 'Not now',
  },
] as const)('paints the proceeding action rightmost and first in the tab order: $shape', ({ props, proceed, stay }) => {
  const surface = open(props)
  const go = button(surface, proceed)
  const keep = button(surface, stay)
  const footer = go.parentElement as HTMLElement
  expect(keep.parentElement).toBe(footer)

  expect(paintedLeftToRight(footer)).toEqual([keep, go])
  expect(tabOrder(surface)).toEqual([go, keep])
})

it('proceeds from the right-hand button and keeps from the left-hand one', () => {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  const surface = open({ onConfirm, onCancel })
  const [left, right] = paintedLeftToRight(button(surface, 'Delete').parentElement as HTMLElement)

  act(() => right?.click())
  expect(onConfirm).toHaveBeenCalledTimes(1)
  expect(onCancel).not.toHaveBeenCalled()

  act(() => left?.click())
  expect(onCancel).toHaveBeenCalledTimes(1)
})

it('holds the action in its place while it waits, and Tab passes over it', () => {
  // `pending`: still counting what confirming would cost. The button stays
  // where the pointer is heading rather than appearing there later.
  const surface = open({ pending: true })
  const go = button(surface, 'Delete')
  const keep = button(surface, 'Keep')
  expect(go.disabled).toBe(true)

  expect(paintedLeftToRight(go.parentElement as HTMLElement)).toEqual([keep, go])
  expect(tabOrder(surface)).toEqual([keep])
})

it('focuses nothing when it opens, so a held Return confirms nothing', async () => {
  const surface = open()
  // Base UI places its initial focus a frame after opening. Wait that frame,
  // or this would pass before it had any chance to fail.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  expect(surface.contains(document.activeElement)).toBe(false)
})

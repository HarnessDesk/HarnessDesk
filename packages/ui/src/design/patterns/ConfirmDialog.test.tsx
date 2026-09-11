import { act, useState, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { ConfirmDialog } from './ConfirmDialog'

/**
 * Where a confirm's two buttons go, and where Tab takes you from the opener —
 * pinned.
 *
 * The footer is `row-reverse`, so the button written first paints rightmost.
 * ConfirmDialog once wrote Keep first: every confirm in the app painted the
 * verb for leaving things alone where the pointer goes to proceed, while the
 * component's comment and the footer's both said otherwise. Nothing failed,
 * because nothing looked.
 *
 * jsdom does no layout, so "rightmost" is read from the two things that decide
 * it — the tree order, and the footer's computed `flex-direction` from the
 * real stylesheet — rather than from either alone: a swap in the markup and a
 * change to the sheet each fail here on their own.
 *
 * The same order decides the keyboard, through Base UI. Nothing is focused on
 * open, so focus stays on the opener, outside the popup, and the popup is
 * bracketed by focus guards: the one before it hands focus to the popup's last
 * control, the one after it to the first. So the first Tab from the opener
 * lands on whichever button is written last. That path runs through the real
 * guards here, from a real opener. Reading the markup alone misses it, and an
 * earlier version of this file did.
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

/** The way every call site opens a confirm: a button sets state, the state renders it. */
const Harness = (props: Partial<Props>) => {
  const [shown, setShown] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setShown(true)}>
        Remove…
      </button>
      {shown && (
        <ConfirmDialog
          title="Delete conversation"
          confirmLabel="Delete"
          onConfirm={() => {}}
          onCancel={() => setShown(false)}
          {...props}
        >
          The transcript goes, and the agent forgets it.
        </ConfirmDialog>
      )}
    </>
  )
}

/** Base UI moves focus off a guard on the next animation frame; wait that frame. */
const frame = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

/** Focuses the opener and presses it, as a keyboard user would. */
const openFromOpener = async (props: Partial<Props> = {}) => {
  act(() => root.render(<Harness {...props} />))
  const opener = container.querySelector('button') as HTMLButtonElement
  opener.focus()
  act(() => opener.click())
  await frame()
  const surface = document.querySelector<HTMLElement>('[role="alertdialog"]')
  if (!surface) throw new Error('the confirm did not open')
  return { opener, surface }
}

/**
 * Tab, as a browser takes it: focus moves to the next focusable element in
 * document order — Base UI's guards included, which sit beside the popup in
 * its portal, outside `[role="alertdialog"]` — and Base UI then gets a frame
 * to move it on. jsdom takes no step of sequential navigation itself, so that
 * one step is taken here; everything after the focus is Base UI's own code.
 * Nothing here sets a positive `tabindex`, so document order is the order.
 */
const pressTab = async (): Promise<void> => {
  const stops = [
    ...document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]'),
  ].filter((each) => each.tabIndex >= 0 && !(each as HTMLButtonElement).disabled)
  const at = stops.indexOf(document.activeElement as HTMLElement)
  const next = stops[at + 1] ?? stops[0]
  act(() => next?.focus())
  await frame()
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
] as const)('paints the proceeding action rightmost: $shape', ({ props, proceed, stay }) => {
  const surface = open(props)
  const go = button(surface, proceed)
  const keep = button(surface, stay)
  const footer = go.parentElement as HTMLElement
  expect(keep.parentElement).toBe(footer)

  expect(paintedLeftToRight(footer)).toEqual([keep, go])
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

it('holds the action in its place while it waits', () => {
  // `pending`: still counting what confirming would cost. The button stays
  // where the pointer is heading rather than appearing there later.
  const surface = open({ pending: true })
  const go = button(surface, 'Delete')
  const keep = button(surface, 'Keep')
  expect(go.disabled).toBe(true)

  expect(paintedLeftToRight(go.parentElement as HTMLElement)).toEqual([keep, go])
})

it('hands the first Tab from the opener to Keep, and the next to the proceeding action', async () => {
  const { opener, surface } = await openFromOpener()
  const go = button(surface, 'Delete')
  const keep = button(surface, 'Keep')
  expect(document.activeElement).toBe(opener)

  await pressTab()
  // Control: whichever order the footer is written in, the first Tab lands on
  // one of the popup's own buttons — so the line after it is the order, not a
  // harness that never reached the popup.
  expect([go, keep]).toContain(document.activeElement)
  expect(document.activeElement).toBe(keep)

  await pressTab()
  expect(document.activeElement).toBe(go)

  await pressTab()
  expect(document.activeElement).toBe(keep)
})

it('never hands Tab to an action that is waiting', async () => {
  const { surface } = await openFromOpener({ pending: true })
  const keep = button(surface, 'Keep')

  await pressTab()
  expect(document.activeElement).toBe(keep)
  // Past Keep, the guard after the popup wraps to its first control that can
  // take focus — Keep again, not the disabled action.
  await pressTab()
  expect(document.activeElement).toBe(keep)
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

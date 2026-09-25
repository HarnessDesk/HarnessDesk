import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { compile } from 'tailwindcss'
import themeSheet from 'tailwindcss/theme.css?raw'
import utilitiesSheet from 'tailwindcss/utilities.css?raw'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { ConfirmDialog } from '../patterns/ConfirmDialog'
import { Dialog } from '../patterns/ModalDialog'
import snapshot from '../tokens.snapshot.txt?raw'
import { Button, buttonVariants } from './button'

/**
 * A dialog's footer has one filled button.
 *
 * The confirm is filled — ink, or red when it destroys — and the way out is
 * quiet. Two things had broken that: a destructive confirm's act was the soft
 * red-text button, the same weight as the Keep beside it (two equal ghosts,
 * no default), and a disabled primary was drawn at half opacity, which on the
 * grey footer is a mid-grey slab that reads as the secondary button.
 *
 * Utilities are compiled by Tailwind itself for the classes the rendered
 * buttons wear, as `dialog.test.tsx` does, so what is asserted is what the
 * engine would apply.
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
  for (const style of [...document.head.querySelectorAll('style')]) style.remove()
})

const applyUtilities = async (classes: readonly string[]): Promise<void> => {
  const compiler = await compile([themeSheet, utilitiesSheet].join('\n'), { base: '/' })
  const style = document.createElement('style')
  style.textContent = compiler.build([...classes])
  document.head.append(style)
}

const classesIn = (scope: ParentNode): string[] =>
  [...new Set([...scope.querySelectorAll('button')].flatMap((one) => one.className.split(/\s+/).filter(Boolean)))]

const byText = (scope: ParentNode, text: string): HTMLButtonElement => {
  const found = [...scope.querySelectorAll('button')].find((one) => one.textContent === text)
  if (!found) throw new Error(`no button "${text}"`)
  return found
}

/* Filled means a ground of its own: anything but transparent. */
const filled = (button: HTMLElement): boolean => {
  const ground = getComputedStyle(button).backgroundColor
  return ground !== '' && ground !== 'transparent' && ground !== 'rgba(0, 0, 0, 0)'
}

it('a destructive confirm acts with a filled red button and keeps with a quiet one', async () => {
  act(() => root.render(
    <ConfirmDialog title="Remove worktree" confirmLabel="Remove worktree" tone="destructive" onConfirm={() => {}} onCancel={() => {}}>
      The folder goes.
    </ConfirmDialog>,
  ))
  const act_ = byText(document, 'Remove worktree')
  const keep = byText(document, 'Keep')
  await applyUtilities(classesIn(document))
  expect(act_.getAttribute('data-variant')).toBe('danger')
  expect(getComputedStyle(act_).backgroundColor).toContain('--hd-btn-danger-fill')
  expect(filled(keep), 'Keep has no ground of its own').toBe(false)
  expect(keep.getAttribute('data-variant')).toBe('quiet')
})

it('draws Cancel quiet in a dialog footer, and the same secondary button filled anywhere else', async () => {
  act(() => root.render(
    <>
      <Button variant="secondary">Elsewhere</Button>
      <Dialog
        title="Save"
        onClose={() => {}}
        footer={
          <>
            <Button>Save</Button>
            <Button variant="secondary">Cancel</Button>
          </>
        }
      />
    </>,
  ))
  await applyUtilities(classesIn(document))
  const footer = document.querySelector('[data-slot="dialog-footer"]')!
  const buttons = [...footer.querySelectorAll('button')]
  // Exactly one filled button in the footer: the confirm.
  expect(buttons.filter(filled).map((one) => one.textContent)).toEqual(['Save'])
  expect(getComputedStyle(byText(footer, 'Cancel')).color).toContain('--hd-secondary-foreground')
  expect(filled(byText(container, 'Elsewhere'))).toBe(true)
})

it('keeps a disabled primary in its own hue rather than fading it to a grey slab', async () => {
  act(() => root.render(<Button disabled>Save and open the brief</Button>))
  const save = byText(container, 'Save and open the brief')
  await applyUtilities(save.className.split(/\s+/))
  const style = getComputedStyle(save)
  // Not the shared half opacity, which mixed the ink with the footer's grey…
  expect(['1', '100%']).toContain(style.opacity)
  // …but the primary's own fill, softened, with its label faded into it.
  expect(style.backgroundColor).toContain('--hd-btn-primary-disabled-fill')
  expect(style.color).toContain('--hd-btn-primary-disabled-foreground')
  // Every other variant still dims the whole control.
  expect(buttonVariants({ variant: 'secondary' })).toContain('disabled:opacity-50')
})

/* The tokens those two lean on, resolved, in every face. */
const faces = (): Map<string, Map<string, string>> => {
  const out = new Map<string, Map<string, string>>()
  let face: Map<string, string> | null = null
  for (const line of snapshot.split('\n')) {
    if (line.startsWith('# ')) {
      face = new Map()
      out.set(line.slice(2).trim(), face)
      continue
    }
    const [name, value] = line.split(' = ')
    if (face && name && value) face.set(name.trim(), value.trim())
  }
  return out
}

const rgb = (value: string): [number, number, number] => {
  const parts = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(value)
  if (!parts) throw new Error(`not a plain rgb(): ${value}`)
  return [Number(parts[1]), Number(parts[2]), Number(parts[3])]
}
const luminance = ([r, g, b]: [number, number, number]): number => {
  const channel = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

it('reads the filled red button at AA in every face', () => {
  const all = faces()
  expect(all.size).toBeGreaterThan(1)
  for (const [name, face] of all) {
    const fill = luminance(rgb(face.get('--hd-btn-danger-fill')!))
    const ink = luminance(rgb(face.get('--hd-btn-danger-foreground')!))
    const ratio = (Math.max(fill, ink) + 0.05) / (Math.min(fill, ink) + 0.05)
    expect(ratio, `${name}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
  }
})

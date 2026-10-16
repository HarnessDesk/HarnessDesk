import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { Button } from '../ui/button'
import { ConfirmDialog } from './ConfirmDialog'
import confirmSheet from './ConfirmDialog.module.css?raw'
import confirmStyles from './ConfirmDialog.module.css'
import formSheet from './DialogForm.module.css?raw'
import formStyles from './DialogForm.module.css'
import { ChoiceList, Fieldset } from './DialogForm'
import { Dialog } from './ModalDialog'
import modalSheet from './ModalDialog.module.css?raw'
import modalStyles from './ModalDialog.module.css'
import { RowChoice, Rows, SectionHead } from './Settings'

/**
 * A dialog pattern owns its box without a tie (#901's rule, for dialogs).
 *
 * In this app a Tailwind utility and a stylesheet class of equal specificity
 * are settled by which sheet the bundle happens to load last. The app loads
 * the modules last and the dev preview loads the utilities last, so any
 * property both say is drawn one way in one and the other way in the other:
 * `ConfirmDialog`'s `.content { padding: 0 }` against the primitive's `p-4`
 * gave every confirm in the preview a second 16px frame. So on every element of both dialogs,
 * no utility may set a property the element's own module rule sets — the
 * pattern says it once, through `cn` (which drops the conflicting utility)
 * or through its sheet, never both.
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
})

const SHORTHAND: Record<string, readonly string[]> = {
  font: ['font-size', 'line-height', 'font-weight', 'font-family'],
  flex: ['flex'],
  'flex-shrink': ['flex'],
  'flex-grow': ['flex'],
  'border-bottom': ['border'],
  'border-top': ['border'],
  'overflow-y': ['overflow'],
  'overflow-x': ['overflow'],
  'max-height': ['max-height'],
  'min-height': ['min-height'],
  'margin-top': ['margin'],
  'margin-bottom': ['margin'],
  'padding-top': ['padding'],
  background: ['background'],
  'background-color': ['background'],
}

/** Every property a module rule for `local` sets, from its plain `.local { }` rules only. */
const sheetSays = (sheet: string, local: string): Set<string> => {
  const said = new Set<string>()
  for (const [, body] of sheet.matchAll(new RegExp(`(?:^|\\n|\\})\\s*\\.${local}\\s*\\{([^}]*)\\}`, 'g'))) {
    for (const [, property] of body!.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)) {
      for (const one of SHORTHAND[property!] ?? [property!]) said.add(one)
    }
  }
  return said
}

/* The one property each utility sets, whatever state it is written under. */
const PROPERTY: readonly [RegExp, string][] = [
  [/^p[trblxy]?-/, 'padding'],
  [/^m[trblxy]?-/, 'margin'],
  [/^gap-/, 'gap'],
  [/^rounded/, 'border-radius'],
  [/^border/, 'border'],
  [/^text-(?:left|right|center|start|end)$/, 'text-align'],
  [/^text-(?:\(length:|xs|sm|base|lg|xl)/, 'font-size'],
  [/^text-/, 'color'],
  [/^leading-/, 'line-height'],
  [/^font-/, 'font-weight'],
  [/^(?:inline-flex|flex|grid|block|inline-block|hidden)$/, 'display'],
  [/^flex-(?:row|col)/, 'flex-direction'],
  [/^(?:flex-(?:1|auto|none|initial)|shrink|grow)/, 'flex'],
  [/^items-/, 'align-items'],
  [/^justify-/, 'justify-content'],
  [/^max-h-/, 'max-height'],
  [/^min-h-/, 'min-height'],
  [/^min-w-/, 'min-width'],
  [/^overflow/, 'overflow'],
  [/^bg-/, 'background'],
  [/^w-/, 'width'],
]
const propertyOf = (utility: string): string | undefined => {
  const bare = utility.split(/:(?![^[(]*[\])])/).at(-1) ?? utility
  return PROPERTY.find(([pattern]) => pattern.test(bare))?.[1]
}

const SHEETS = [
  { name: 'ConfirmDialog', sheet: confirmSheet, styles: confirmStyles as Record<string, string> },
  { name: 'ModalDialog', sheet: modalSheet, styles: modalStyles as Record<string, string> },
  { name: 'DialogForm', sheet: formSheet, styles: formStyles as Record<string, string> },
]

/** Every element under `scope` that wears a module class, with what ties on it. */
const ties = (scope: ParentNode): { element: string; local: string; ties: string[] }[] => {
  const found: { element: string; local: string; ties: string[] }[] = []
  for (const element of scope.querySelectorAll<HTMLElement>('[class]')) {
    const classes = (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
    for (const { name, sheet, styles } of SHEETS) {
      for (const [local, hashed] of Object.entries(styles)) {
        if (!classes.includes(hashed)) continue
        const said = sheetSays(sheet, local)
        const tying = classes.filter((one) => one !== hashed && !Object.values(styles).includes(one) && said.has(propertyOf(one) ?? ''))
        found.push({ element: `${name}.${local} <${element.tagName.toLowerCase()}>`, local, ties: tying })
      }
    }
  }
  return found
}

it('a confirm owns its box: no utility on any of its parts ties with its sheet', () => {
  act(() => root.render(
    <ConfirmDialog title="Remove worktree" confirmLabel="Remove worktree" tone="destructive" onConfirm={() => {}} onCancel={() => {}}>
      <p>The folder goes.</p>
    </ConfirmDialog>,
  ))
  const parts = ties(document.body)
  // The guard on the guard: every part the sheet draws was found and read.
  expect(parts.map((one) => one.local).sort()).toEqual(expect.arrayContaining(['body', 'footer', 'header', 'title', 'footerActions']))
  for (const part of parts) expect(part.ties, part.element).toEqual([])
})

it('the confirm is a column with no padding of its own, said once as utilities', () => {
  act(() => root.render(
    <ConfirmDialog title="Remove it?" confirmLabel="Remove" onConfirm={() => {}} onCancel={() => {}}>
      <p>It goes.</p>
    </ConfirmDialog>,
  ))
  const popup = document.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]')!
  const classes = popup.className.split(/\s+/)
  expect(classes).toEqual(expect.arrayContaining(['flex', 'flex-col', 'p-0', 'gap-0']))
  // The primitive's grid, gap and padding were dropped by the merge, not
  // left to lose a tie.
  for (const gone of ['grid', 'p-4', 'gap-3']) expect(classes).not.toContain(gone)
})

it('a dialog owns its box: no utility on any of its parts ties with its sheet', () => {
  act(() => root.render(
    <Dialog
      title="Save as an Agent"
      icon={<span>i</span>}
      bodyPrelude="Where"
      onClose={() => {}}
      footer={<Button>Save</Button>}
      footerAside="⌘⏎"
    >
      <p>Body</p>
      <Fieldset legend="The most it may do" hint="One of four.">
        <ChoiceList
          label="The most it may do"
          value="read"
          onChange={() => {}}
          options={[{ value: 'read', title: 'Read', description: 'Changes nothing.' }, { value: 'edit', title: 'Edit' }]}
        />
      </Fieldset>
      <SectionHead name="Where it is kept" description="Either place." />
      <Rows role="radiogroup" aria-label="Where it is kept">
        <RowChoice title="For you" desc="On this Mac." selected onClick={() => {}} />
      </Rows>
    </Dialog>,
  ))
  const parts = ties(document.body)
  expect(parts.map((one) => one.local)).toEqual(expect.arrayContaining([
    'header', 'title', 'bodyPrelude', 'body', 'footer', 'footerActions', 'stack',
    'fieldset', 'fieldsetBody', 'legend', 'legendName', 'legendHint', 'choiceList', 'choice', 'radio', 'choiceTitle', 'choiceDesc',
  ]))
  for (const part of parts) expect(part.ties, part.element).toEqual([])
})

it('E9 modal focus returns to its opener, and a nested menu spends Escape first', async () => {
  const { Menu, MenuItem, Popover } = await import('..')
  const Harness = () => {
    const [open, setOpen] = useState(false)
    return <><Button onClick={() => setOpen(true)}>Open dialog</Button>{open && <Dialog title="Modal policy" onClose={() => setOpen(false)}><Popover label="Range">{close => <Menu close={close}><MenuItem label="Last 30 days" onSelect={close} /></Menu>}</Popover></Dialog>}</>
  }
  await act(async () => root.render(<Harness />))
  const opener=container.querySelector<HTMLButtonElement>('button')!
  opener.focus(); await act(async () => opener.click())
  const frame=()=>act(async()=>{await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))})
  await frame()
  const dialog=document.querySelector<HTMLElement>('[role="dialog"]')!
  expect(dialog).not.toBeNull(); expect(dialog.contains(document.activeElement)).toBe(true)
  const trigger=dialog.querySelector<HTMLButtonElement>('[data-slot="popover-trigger"]')!
  await act(async () => {trigger.focus();trigger.click()})
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  expect(dialog.contains(document.querySelector('[role="menu"]'))).toBe(true)
  const escape=()=>act(async()=>{document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))})
  await escape();await frame()
  expect(document.querySelector('[role="menu"]')).toBeNull();expect(document.querySelector('[role="dialog"]')).toBe(dialog)
  expect(document.activeElement).toBe(trigger)
  await escape();await frame()
  expect(document.querySelector('[role="dialog"]')).toBeNull();expect(document.activeElement).toBe(opener)
})
it('E9 a canonical modal dismisses on an outside press', async () => {
  const Harness=()=>{const [open,setOpen]=useState(true);return open?<Dialog title="Outside policy" onClose={()=>setOpen(false)}>Inside</Dialog>:null}
  await act(async()=>root.render(<Harness />))
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  const backdrop=document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')!
  expect(backdrop).not.toBeNull()
  await act(async()=>{backdrop.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));backdrop.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));backdrop.click()})
  await act(async()=>{await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))})
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

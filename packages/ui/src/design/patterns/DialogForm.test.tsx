import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Input } from '../ui/input'
import formSheet from './DialogForm.module.css?raw'
import { ChoiceList, DialogFormScope, Fieldset } from './DialogForm'
import { Dialog } from './ModalDialog'
import settingsSheet from './Settings.module.css?raw'
import { Field, FormStack, Note, RowChoice, Rows, SectionHead } from './Settings'

/**
 * A dialog's form grammar: the parts a screen already writes come out as a
 * form when they are inside a dialog, without the screen saying so.
 *
 * jsdom lays nothing out, so the rhythm itself is read from the sheet (the
 * numbers are the contract), and the anatomy from the rendered tree: which
 * part each one became, and what a screen reader is told.
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

const render = async (node: React.ReactNode): Promise<void> => {
  await act(async () => {
    root.render(node)
  })
}

/** The declarations of one rule, as written. */
const rule = (sheet: string, selector: string): string => {
  const match = new RegExp(`(?:^|\\n)${selector.replace(/[.:()+>[\]='"-]/g, '\\$&')} \\{([^}]*)\\}`).exec(sheet)
  if (!match?.[1]) throw new Error(`no ${selector} rule`)
  return match[1]
}

const Answer = ({ inDialog }: { inDialog: boolean }) => {
  const [level, setLevel] = useState('read')
  const body = (
    <FormStack>
      <Note>One sentence about the form.</Note>
      <SectionHead name="The most it may do" />
      <Rows role="radiogroup" aria-label="The most it may do">
        <RowChoice title="Read" desc="Changes nothing." selected={level === 'read'} onClick={() => setLevel('read')} />
        <RowChoice title="Edit" desc="May change files." selected={level === 'edit'} onClick={() => setLevel('edit')} />
      </Rows>
      <Rows>{[]}</Rows>
    </FormStack>
  )
  return inDialog ? <DialogFormScope>{body}</DialogFormScope> : body
}

describe('inside a dialog', () => {
  it('draws a section head as a legend and a radio card as a compact choice list', async () => {
    await render(<Answer inDialog />)
    expect(container.querySelector('[data-slot="fieldset-legend"]')?.textContent).toBe('The most it may do')
    const list = container.querySelector('[role="radiogroup"]')!
    expect(list.getAttribute('data-slot')).toBe('choice-list')
    const rows = [...list.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(rows.map((row) => row.getAttribute('data-slot'))).toEqual(['choice-row', 'choice-row'])
    // A real radio mark, not a tick column.
    expect(rows[0]!.querySelector('[data-checked]')).not.toBeNull()
    expect(rows[1]!.querySelector('[data-checked]')).toBeNull()
  })

  it('shows only the chosen answer’s description, and still describes every answer', async () => {
    await render(<Answer inDialog />)
    const rows = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    const described = (row: HTMLElement) => document.getElementById(row.getAttribute('aria-describedby')!)!
    expect(described(rows[0]!).hidden).toBe(false)
    expect(described(rows[1]!).hidden).toBe(true)
    expect(described(rows[1]!).textContent).toBe('May change files.')

    await act(async () => rows[1]!.click())
    expect(described(rows[0]!).hidden).toBe(true)
    expect(described(rows[1]!).hidden).toBe(false)
  })

  it('arrow keys move the answer, one tab stop for the group', async () => {
    await render(<Answer inDialog />)
    const rows = () => [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(rows().map((row) => row.tabIndex)).toEqual([0, -1])
    rows()[0]!.focus()
    await act(async () => {
      rows()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(rows().map((row) => row.getAttribute('aria-checked'))).toEqual(['false', 'true'])
    expect(document.activeElement).toBe(rows()[1])
  })

  it('keeps the form stack’s rhythm: no page margins on notes or cards, and no empty card', async () => {
    await render(<Answer inDialog />)
    expect(container.querySelector('[data-slot="note"]')?.getAttribute('data-context')).toBe('dialog')
    expect(container.querySelector('[data-slot="form-stack"]')?.className).toMatch(/stack/)
    // The empty card is not drawn at all — it was a stray rule under a field.
    expect(container.querySelectorAll('[role="radiogroup"] ~ div').length).toBe(0)
  })

  it('a Dialog puts its body in the scope, so a screen needs no edit', async () => {
    await render(
      <Dialog title="Save" onClose={() => {}}>
        <SectionHead name="Where it is kept" />
        <Rows role="radiogroup" aria-label="Where it is kept">
          <RowChoice title="For you" selected onClick={() => {}} />
        </Rows>
      </Dialog>,
    )
    const body = document.querySelector('[data-slot="modal-dialog-body"]')!
    expect(body.className).toMatch(/stack/)
    expect(body.querySelector('[data-slot="fieldset-legend"]')).not.toBeNull()
    expect(body.querySelector('[data-slot="choice-row"]')).not.toBeNull()
  })
})

describe('outside a dialog', () => {
  it('a settings page keeps its section head and its card of rows', async () => {
    await render(<Answer inDialog={false} />)
    expect(container.querySelector('[data-slot="fieldset-legend"]')).toBeNull()
    expect(container.querySelector('[data-slot="section-name"]')).not.toBeNull()
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute('data-slot')).toBeNull()
    expect(container.querySelector('[data-slot="choice-row"]')).toBeNull()
    expect(container.querySelector('[data-slot="note"]')?.hasAttribute('data-context')).toBe(false)
  })
})

describe('Fieldset and ChoiceList', () => {
  it('a fieldset is a group named by its legend', async () => {
    await render(
      <Fieldset legend="Seat these Agents" hint="Each gets a seat.">
        <label><input type="checkbox" /> Code reviewer</label>
      </Fieldset>,
    )
    const group = container.querySelector('[role="group"]')!
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe('Seat these AgentsEach gets a seat.')
  })

  it('a choice list is one radio group with the Tab entry on its answer', async () => {
    const seen: string[] = []
    await render(
      <ChoiceList
        label="Ceiling"
        value={null}
        onChange={(next) => seen.push(next)}
        options={[{ value: 'a', title: 'A', disabled: true }, { value: 'b', title: 'B', description: 'Bee.' }]}
      />,
    )
    const rows = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Ceiling')
    // No answer yet: the first answer that can be chosen is the way in.
    expect(rows.map((row) => row.tabIndex)).toEqual([-1, 0])
    await act(async () => rows[1]!.click())
    expect(seen).toEqual(['b'])
  })
})

describe('the rhythm, as the sheets say it', () => {
  it('fields 16px apart, a label or a legend 6px over what it names', () => {
    expect(rule(formSheet, '.stack')).toMatch(/gap:\s*var\(--hd-space-4\)/)
    expect(rule(settingsSheet, '.formField')).toMatch(/gap:\s*var\(--hd-space-1-5\)/)
    // A legend written before its group is pulled onto it: 16px becomes 6px.
    expect(rule(formSheet, '.stack > .legend')).toMatch(/margin-bottom:\s*calc\(var\(--hd-space-1-5\) - var\(--hd-space-4\)\)/)
    expect(rule(formSheet, '.fieldset')).toMatch(/gap:\s*var\(--hd-space-1-5\)/)
  })

  it('a choice row is a control’s height, not a settings row’s', () => {
    expect(rule(formSheet, '.choice')).toMatch(/min-height:\s*var\(--hd-btn-h\)/)
    expect(rule(formSheet, '.choice')).toMatch(/padding:\s*var\(--hd-space-1-5\) var\(--hd-space-2\)/)
  })

  it('a hint sits a step below its label; the legend is drawn as the label is', () => {
    expect(rule(settingsSheet, '.formHint')).toMatch(/font-size:\s*var\(--hd-text-xs\)/)
    expect(rule(settingsSheet, '.formLabel')).toMatch(/font-size:\s*var\(--hd-text-sm\)/)
    for (const property of ['font-size', 'line-height', 'font-weight', 'color']) {
      const of = (body: string) => new RegExp(`${property}:\\s*([^;]+);`).exec(body)?.[1]
      expect(of(rule(formSheet, '.legendName')), property).toBe(of(rule(settingsSheet, '.formLabel')))
    }
  })
})

describe('Field', () => {
  it('says "Optional" at the label’s end, apart from the label', async () => {
    await render(
      <Field label="Detail" optional hint="One line.">
        {(control) => <Input {...control} value="" onChange={() => {}} />}
      </Field>,
    )
    const label = container.querySelector('label')!
    expect(label.textContent).toBe('Detail')
    expect(container.querySelector('[data-slot="form-optional"]')?.textContent).toBe('Optional')
  })

  it('draws no "Optional" unless asked', async () => {
    await render(
      <Field label="Name">
        {(control) => <Input {...control} value="" onChange={() => {}} />}
      </Field>,
    )
    expect(container.querySelector('[data-slot="form-optional"]')).toBeNull()
  })
})

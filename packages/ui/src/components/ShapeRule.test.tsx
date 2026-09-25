import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { FlowPolicy, FlowPolicyRule } from '@harnessdesk/protocol'

import { ShapeRule } from './ShapeRule'

/**
 * One rule, edited by the finite vocabulary the engine reads: any/every over
 * declared answers stay separate fields from evidence guards — a label or a
 * message is never itself evidence — and the five supported guard kinds are
 * the only ones offered.
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
})

const POLICY: FlowPolicy = {
  version: 2, name: 'x', inputs: [], messaging: 'board-only', wait: 240,
  roles: [
    { id: 'writer', kind: 'agent', uses: ['implementer'], seats: [], isolate: false, grant: 'edit', independentOf: [] },
    { id: 'merge', kind: 'agent', uses: ['implementer'], seats: [], isolate: false, grant: 'merge', independentOf: ['writer'] },
  ],
  rules: [],
  seed: { role: 'writer', title: 'Go' },
}

const RULE: FlowPolicyRule = { id: 'to-merge', on: 'writer', then: { role: 'merge', title: 'Merge' } }

/** `ShapeRule` is controlled: it renders only what `rule` says, so a test that clicks a second control must feed the previous `onChange` back in, exactly as `ShapeEditor` does. */
const render = (rule: FlowPolicyRule) => {
  const onChange = vi.fn((next: FlowPolicyRule) => {
    act(() => {
      root.render(<ShapeRule rule={next} policy={POLICY} onChange={onChange} onRemove={onRemove} />)
    })
  })
  const onRemove = vi.fn()
  act(() => {
    root.render(<ShapeRule rule={rule} policy={POLICY} onChange={onChange} onRemove={onRemove} />)
  })
  return { onChange, onRemove }
}

const textareaFor = (label: string): HTMLTextAreaElement => {
  const el = [...container.querySelectorAll('label')].find((one) => one.textContent?.startsWith(label))
  if (!el) throw new Error(`no field “${label}”`)
  const id = el.getAttribute('for')!
  return container.querySelector(`#${id}`) as HTMLTextAreaElement
}
const setValue = (el: HTMLTextAreaElement | HTMLInputElement, value: string): void => {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

it('every/any answers and evidence guards are separate fields, never merged into one', () => {
  const { onChange } = render(RULE)

  act(() => setValue(textareaFor('Every one of these answers'), 'approve\nlgtm'))
  expect(onChange).toHaveBeenLastCalledWith({ ...RULE, when: { every: ['approve', 'lgtm'] } })

  // Editing "any" next accumulates onto the same `when` — every, any and
  // evidence are three fields of one condition, not three exclusive modes —
  // but touching one never invents a value in another.
  act(() => setValue(textareaFor('Any one of these answers'), 'urgent'))
  expect(onChange).toHaveBeenLastCalledWith({ ...RULE, when: { every: ['approve', 'lgtm'], any: ['urgent'] } })
  const last = onChange.mock.calls.at(-1)![0] as FlowPolicyRule
  expect(last.when?.evidence).toBeUndefined()
})

it('adding an evidence guard offers exactly the five supported kinds, and a label is never one of them', () => {
  render(RULE)
  const button = [...container.querySelectorAll('button')].find((one) => one.textContent?.includes('Add a guard'))!
  act(() => button.click())

  const select = container.querySelector('select[aria-label="Guard 1 kind"]') as HTMLSelectElement
  const options = [...select.options].map((one) => one.value)
  expect(options).toEqual(['check', 'ci', 'review', 'pr', 'diff'])
  // A guard defaults to `check`, never an arbitrary label or message string.
  expect(container.textContent).toContain('A named check passed')
})

it('a merge-granted target with no evidence guard is still just data here — the compiler, not this row, refuses it', () => {
  // ShapeRule never blocks building a rule the compiler will later refuse (a
  // merge step needs fresh evidence): typing an answer here reports exactly
  // that shape, evidence and all, and leaves the refusal to `writeShape` /
  // the dry run.
  const { onChange } = render(RULE)
  expect(RULE.then.role).toBe('merge')
  act(() => setValue(textareaFor('Every one of these answers'), 'approve'))
  const sent = onChange.mock.calls.at(-1)![0] as FlowPolicyRule
  expect(sent.when).toEqual({ every: ['approve'] })
  expect(sent.when?.evidence).toBeUndefined()
})

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Field, Input, Select } from './Kit'

/**
 * What `Field` promises its control: the label points at it, and whatever is
 * written under it is announced with it. The caller spreads one object and
 * gets all of that — the wiring nobody remembers on the twelfth form.
 */

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

const render = async (node: React.ReactNode): Promise<void> => {
  await act(async () => {
    root.render(node)
  })
}

describe('Field', () => {
  it('ties the label and the hint to the control', async () => {
    await render(
      <Field label="Endpoint" hint="Where requests go.">
        {(control) => <Input {...control} value="" onChange={() => {}} />}
      </Field>,
    )
    const input = container.querySelector('input') as HTMLInputElement
    const label = container.querySelector('label') as HTMLLabelElement
    expect(label.htmlFor).toBe(input.id)
    const described = document.getElementById(input.getAttribute('aria-describedby') ?? '')
    expect(described?.textContent).toBe('Where requests go.')
    expect(input.getAttribute('aria-invalid')).toBeNull()
  })

  it('replaces the hint with an announced error and marks the control invalid', async () => {
    await render(
      <Field label="Matching" hint="Text the request must contain." error="Not a valid pattern.">
        {(control) => <Input {...control} value="[" onChange={() => {}} />}
      </Field>,
    )
    const input = container.querySelector('input') as HTMLInputElement
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const described = document.getElementById(input.getAttribute('aria-describedby') ?? '')
    expect(described?.getAttribute('role')).toBe('alert')
    expect(described?.textContent).toBe('Not a valid pattern.')
    expect(container.textContent).not.toContain('Text the request must contain.')
  })

  it('wires a select the same way', async () => {
    await render(
      <Field label="Then" hint="What the rule does.">
        {(control) => (
          <Select
            {...control}
            label="What the rule does"
            value="deny"
            options={[{ value: 'deny', label: 'Deny it' }]}
            onChange={() => {}}
          />
        )}
      </Field>,
    )
    const select = container.querySelector('select') as HTMLSelectElement
    const label = container.querySelector('label') as HTMLLabelElement
    expect(label.htmlFor).toBe(select.id)
    expect(document.getElementById(select.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'What the rule does.',
    )
  })
})

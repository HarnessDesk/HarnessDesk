import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Field, FormStack, Row, RowInput, Rows } from './Settings'

/**
 * A value typed into a settings row applies the way a switch does — no Save
 * button: on Enter or when the field is left, never while it still reads as
 * stored, and Escape puts back what is stored. A refused value stays in the
 * field, marked, so it can be mended.
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

const type = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const key = (input: HTMLInputElement, name: string): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
  act(() => {
    input.dispatchEvent(event)
  })
  return event
}

const Port = ({ onCommit, refuse = false }: { onCommit: (next: string) => void; refuse?: boolean }) => {
  const [stored, setStored] = useState('30000')
  const [invalid, setInvalid] = useState(false)
  return (
    <Rows>
      <Row
        title="Starting port"
        control={(
          <RowInput
            aria-label="Starting port"
            type="number"
            value={stored}
            invalid={invalid}
            onCommit={(next) => {
              onCommit(next)
              if (refuse) setInvalid(true)
              else setStored(next)
            }}
          />
        )}
      />
    </Rows>
  )
}

const field = (): HTMLInputElement => container.querySelector('[data-slot="row-input"]') as HTMLInputElement

describe('RowInput', () => {
  it('applies on Enter and on leaving the field, and only when the value changed', () => {
    const onCommit = vi.fn()
    act(() => root.render(<Port onCommit={onCommit} />))
    act(() => field().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(onCommit).not.toHaveBeenCalled()

    type(field(), '31000')
    expect(onCommit).not.toHaveBeenCalled()
    const enter = key(field(), 'Enter')
    expect(enter.defaultPrevented).toBe(true)
    expect(onCommit).toHaveBeenLastCalledWith('31000')

    type(field(), '32000')
    act(() => field().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(onCommit).toHaveBeenLastCalledWith('32000')
    expect(onCommit).toHaveBeenCalledTimes(2)
  })

  it('puts back what is stored on Escape, and leaves Escape alone when there is nothing to undo', () => {
    const onCommit = vi.fn()
    act(() => root.render(<Port onCommit={onCommit} />))
    type(field(), '999')
    const undo = key(field(), 'Escape')
    expect(field().value).toBe('30000')
    expect(undo.defaultPrevented).toBe(true)
    const pass = key(field(), 'Escape')
    expect(pass.defaultPrevented).toBe(false)
    act(() => field().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('keeps a refused value in the field and marks it invalid', () => {
    act(() => root.render(<Port onCommit={() => {}} refuse />))
    type(field(), '80')
    key(field(), 'Enter')
    expect(field().value).toBe('80')
    expect(field().getAttribute('aria-invalid')).toBe('true')
  })

  it('is as wide as the value it holds, not the row', () => {
    act(() => root.render(<Port onCommit={() => {}} />))
    expect(field().className).toContain('w-24')
    expect(field().className).not.toMatch(/(^|\s)w-full(\s|$)/)
  })
})

describe('FormStack', () => {
  it('lets a button keep its own width while fields take the column', () => {
    act(() => root.render(
      <FormStack>
        <Field label="Name">{(control) => <Input {...control} value="" onChange={() => {}} />}</Field>
        <Button>Apply</Button>
      </FormStack>,
    ))
    const stack = container.querySelector('[data-slot="form-stack"]') as HTMLElement
    const button = container.querySelector('[data-slot="button"]') as HTMLElement
    const fieldBox = container.querySelector('[data-slot="form-field"]') as HTMLElement
    expect(getComputedStyle(stack).alignItems).toBe('flex-start')
    expect(getComputedStyle(fieldBox).alignSelf).toBe('stretch')
    expect(getComputedStyle(button).alignSelf).not.toBe('stretch')
  })
})

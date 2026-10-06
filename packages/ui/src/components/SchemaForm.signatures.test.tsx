import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SchemaForm } from './SchemaForm'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('shows shared signature placeholders once and saves explicitly empty templates', () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const save = vi.fn()
  const schema = {
    type: 'object', description: 'Placeholders: {role}, {round}, {team}, {seat}. Empty disables signing.',
    properties: Object.fromEntries(['Description', 'Review', 'Comment'].map((name) => [name.toLowerCase(), {type: 'string', title: name + ' signature', default: 'Default template'}])),
  }
  try {
    act(() => root.render(<SchemaForm schema={schema} value={{description:'Earlier', review:'Earlier', comment:'Earlier'}} onSubmit={save} />))
    expect(container.textContent?.match(/Placeholders:/g)).toHaveLength(1)
    for (const input of container.querySelectorAll('input')) {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '')
        input.dispatchEvent(new Event('input', {bubbles:true}))
      })
    }
    act(() => container.querySelector('button')!.click())
    expect(save).toHaveBeenCalledWith({description:'',review:'',comment:''})
  } finally {act(() => root.unmount());container.remove()}
})

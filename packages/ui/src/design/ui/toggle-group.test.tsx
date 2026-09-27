import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { ToggleGroup, ToggleGroupItem } from './toggle-group'

/**
 * `value === undefined` must stay uncontrolled so `defaultValue` seeds the
 * group; only an explicit `''` collapses to an empty controlled selection.
 * See the header comment in toggle-group.tsx for the regression this guards.
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

const pressedValues = () =>
  [...container.querySelectorAll('[data-slot="toggle-group-item"]')]
    .filter((item) => item.getAttribute('data-pressed') !== null)
    .map((item) => item.textContent)

it('seeds its selection from defaultValue when no value is passed', async () => {
  await act(async () =>
    root.render(
      <ToggleGroup type="single" defaultValue="one">
        <ToggleGroupItem value="one">One</ToggleGroupItem>
        <ToggleGroupItem value="two">Two</ToggleGroupItem>
      </ToggleGroup>,
    ),
  )
  expect(pressedValues()).toEqual(['One'])
})

it('a controlled value still wins over defaultValue, and updates', async () => {
  const Controlled = () => {
    const [value, setValue] = useState('two')
    return (
      <ToggleGroup type="single" value={value} defaultValue="one" onValueChange={setValue}>
        <ToggleGroupItem value="one">One</ToggleGroupItem>
        <ToggleGroupItem value="two">Two</ToggleGroupItem>
      </ToggleGroup>
    )
  }
  await act(async () => root.render(<Controlled />))
  expect(pressedValues()).toEqual(['Two'])
  const first = container.querySelector('[data-slot="toggle-group-item"]') as HTMLElement
  await act(async () => first.click())
  expect(pressedValues()).toEqual(['One'])
})

it('an explicitly empty controlled value stays empty', async () => {
  await act(async () =>
    root.render(
      <ToggleGroup type="single" value="" defaultValue="one">
        <ToggleGroupItem value="one">One</ToggleGroupItem>
        <ToggleGroupItem value="two">Two</ToggleGroupItem>
      </ToggleGroup>,
    ),
  )
  expect(pressedValues()).toEqual([])
})

it('the segmented pattern, which always passes value, is unaffected', async () => {
  const Segmented = () => {
    const [value, setValue] = useState('medium')
    return (
      <ToggleGroup type="single" value={value} onValueChange={setValue}>
        <ToggleGroupItem value="low">Low</ToggleGroupItem>
        <ToggleGroupItem value="medium">Medium</ToggleGroupItem>
        <ToggleGroupItem value="high">High</ToggleGroupItem>
      </ToggleGroup>
    )
  }
  await act(async () => root.render(<Segmented />))
  expect(pressedValues()).toEqual(['Medium'])
  const items = [...container.querySelectorAll('[data-slot="toggle-group-item"]')]
  await act(async () => (items[2] as HTMLElement).click())
  expect(pressedValues()).toEqual(['High'])
})

it('the multiple-selection type is unaffected: undefined stays uncontrolled and defaultValue seeds it', async () => {
  await act(async () =>
    root.render(
      <ToggleGroup type="multiple" defaultValue={['one', 'two']}>
        <ToggleGroupItem value="one">One</ToggleGroupItem>
        <ToggleGroupItem value="two">Two</ToggleGroupItem>
        <ToggleGroupItem value="three">Three</ToggleGroupItem>
      </ToggleGroup>,
    ),
  )
  expect(pressedValues()).toEqual(['One', 'Two'])
})

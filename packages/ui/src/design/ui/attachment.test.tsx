import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { Attachment, AttachmentMedia } from './attachment'

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

it('offers the image-only tile used by a composer preview', () => {
  act(() => root.render(
    <Attachment orientation="tile">
      <AttachmentMedia variant="image"><img src="data:image/png;base64,AA" alt="Draft" /></AttachmentMedia>
    </Attachment>,
  ))
  const attachment = container.querySelector('[data-slot="attachment"]')
  const media = container.querySelector('[data-slot="attachment-media"]')
  expect(attachment?.getAttribute('data-orientation')).toBe('tile')
  expect(attachment?.className).toContain('size-20')
  expect(media?.className).toContain('group-data-[orientation=tile]/attachment:size-full')
})

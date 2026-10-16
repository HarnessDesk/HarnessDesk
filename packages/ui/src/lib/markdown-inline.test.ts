import { expect, it } from 'vitest'
import { inlineMarkdown } from './markdown-inline'

it('formats code while keeping descriptions inside row buttons non-interactive', () => {
  const box = document.createElement('div')
  box.innerHTML = inlineMarkdown('Read `src/` and [Guide](https://example.com/docs). <a href="https://example.com">Notes</a><script>bad()</script>')
  expect(box.querySelector('code')?.textContent).toBe('src/')
  expect(box.textContent).toContain('Guide')
  expect(box.textContent).toContain('Notes')
  expect(box.querySelector('script')).toBeNull()
  expect(box.querySelector('a')).toBeNull()
})

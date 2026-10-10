import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { InfoCardBody } from './InfoCard'
test('facts render as one list, without controls or nested cards', () => {
  const html = renderToStaticMarkup(<InfoCardBody title="Storefront catalogue review" rows={[
    { id: 'branch', label: 'Branch', value: 'feature/storefront-checkout', kind: 'path' },
    { id: 'status', label: 'Status', value: 'Working — 41 seconds into this turn' },
  ]} notes={['The files stay as they are.']} />)
  expect(html).toContain('data-info-facts')
  expect(html).not.toMatch(/<(?:button|a|input|select|textarea)\b/)
  expect(html).not.toContain('summary-list')
})

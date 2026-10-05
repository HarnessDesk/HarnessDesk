import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

// The built app reaches the icon facade before notice patterns. A barrel cycle
// must not leave those patterns holding uninitialized glyphs when accounts load.
import './Icons'
import { NoticeStrip } from '../design'

it('renders a standing runtime notice after loading the icon facade first', () => {
  const markup = renderToStaticMarkup(<NoticeStrip messages={[{ id: 'runtime-info', tone: 'info', title: 'Runtime information' }]} onDismiss={() => {}} />)
  expect(markup).toContain('lucide-info')
  expect(markup).toContain('Runtime information')
})

import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { WideMenuRows } from './WideMenu'
import { MenuPresentation } from '../ui/menu-row'

test('a missing reading occupies the same figure column as a real reading', () => {
  const html = renderToStaticMarkup(<MenuPresentation icons="none" wide><WideMenuRows items={[]} facts={[
    { id: 'daily', name: 'Daily', percent: 78, countdown: '3h' },
    { id: 'weekly', name: 'Weekly', percent: null, countdown: '', note: 'No usage reported' },
  ]} /></MenuPresentation>)
  expect(html.match(/data-meter-column="reading"/g)).toHaveLength(2)
  expect(html).toContain('No usage reported')
})

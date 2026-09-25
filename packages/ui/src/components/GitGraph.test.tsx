import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import { laneWindow, type GraphRow } from '../lib/git-graph'
import { GitGraph } from './GitGraph'

const row: GraphRow = {
  sha: 'demo', lane: 0, color: 1, width: 2,
  segments: [{ kind: 'pass', from: 0, to: 0, color: 1 }, { kind: 'out', from: 0, to: 1, color: 2 }],
}

it('preserves graph geometry and lane colors in a dedicated data-mark renderer', () => {
  const html = renderToStaticMarkup(<GitGraph row={row} lanes={laneWindow([row], 2)} rowHeight={26} laneWidth={12} />)
  expect(html).toContain('width="24" height="26"')
  expect(html).toContain('x1="6" y1="0" x2="6" y2="26"')
  expect(html).toContain('d="M 6 13 C 6 24 18 13 18 26"')
  expect(html).toContain('fill="var(--lane-1)"')
})

it('omits hidden segments and draws a hollow mark for a hidden commit lane', () => {
  const html = renderToStaticMarkup(<GitGraph row={{ ...row, lane: 1 }} lanes={laneWindow([row], 1)} rowHeight={26} laneWidth={12} offGraphClassName="off-graph" />)
  expect(html).not.toContain('<path')
  expect(html).toContain('class="off-graph" cx="6" cy="13" r="3" fill="none"')
})

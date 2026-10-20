import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { runFixture } from '../preview/run-view-fixture'
import { TeamRunFacts } from './TeamRunFacts'
import type { BoardEvidence } from '@harnessdesk/protocol'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('preserves the recorded brief, frozen base and only fresh checks and clean changes at the observed PR head', () => {
  const fixture = runFixture()
  const input = { ...fixture, execution: { ...fixture.execution, base: { remote: 'origin', branch: 'main', at: 'abc123' } },
    evidence: { room: fixture.execution.goal, stamp: 1, checks: [], refused: [], unreadable: null, cards: [{card:1,running:[],facts:[
      {record:{id:'pr',observedAt:4,fact:{kind:'pr',number:7,url:'https://example.com/pull/7',head:'head-a',state:'open'},checkout:{branch:'review/old'}},freshness:{state:'fresh'},by:null},
      {record:{id:'ci',observedAt:3,fact:{kind:'ci',at:'head-a',checks:[{name:'compile',state:'success'}]}},freshness:{state:'fresh'},by:null},
      {record:{id:'diff',observedAt:2,fact:{kind:'diff',to:'head-a',dirty:false,added:5,removed:2}},freshness:{state:'fresh'},by:null},
      {record:{id:'stale',observedAt:6,fact:{kind:'ci',at:'head-a',checks:[{name:'old',state:'failure'}]}},freshness:{state:'stale'},by:null},
      {record:{id:'other',observedAt:7,fact:{kind:'ci',at:'other-head',checks:[{name:'other',state:'pending'}]}},freshness:{state:'fresh'},by:null},
    ]}] } as unknown as BoardEvidence }
  const container = document.createElement('div'), root = createRoot(container)
  try {
    act(() => root.render(<TeamRunFacts input={input} number={1} at="head-a" />))
    for (const words of [fixture.execution.brief!, 'origin · main · abc123', '1 success', '5', '2']) expect(container.textContent).toContain(words)
    expect(container.textContent).not.toContain('failure')
    expect(container.textContent).not.toContain('pending')
    expect(container.querySelector('[data-slot="card"]')).toBeNull()
  } finally {act(() => root.unmount())}
})

it('keeps the origin description and its Open action on Started by', () => {
  const fixture = runFixture()
  const container = document.createElement('div'), root = createRoot(container)
  try {
    act(() => root.render(<TeamRunFacts input={fixture} number={1} at="head-a" originNote="From the pull request" originAction={<button type="button">Open origin</button>} />))
    const row = [...container.querySelectorAll('[data-slot="summary-item"]')].find(one => one.textContent?.includes('Started by'))
    expect(row?.textContent).toContain('From the pull request')
    expect(row?.querySelector('button')?.textContent).toBe('Open origin')
  } finally { act(() => root.unmount()) }
})

it('gives up the middle of a long revision rather than overflowing, keeping the whole hash readable', () => {
  const fixture = runFixture()
  const revision = 'f'.repeat(40)
  const container = document.createElement('div'), root = createRoot(container)
  try {
    act(() => root.render(<TeamRunFacts input={{ ...fixture, execution: { ...fixture.execution, revision } }} number={1} at="head-a" />))
    const note = container.querySelector<HTMLElement>('[data-slot="summary-note"] [data-slot="middle-truncate"]')
    expect(note?.textContent).toContain(`Revision ${revision}`)
  } finally { act(() => root.unmount()) }
})

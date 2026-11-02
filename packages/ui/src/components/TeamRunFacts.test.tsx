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
    act(() => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Record details'))!.click())
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
    expect(container.textContent).not.toContain(`Revision ${revision}`)
    act(() => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Record details'))!.click())
    const row = [...container.querySelectorAll('[data-slot="summary-item"]')].find(one => one.querySelector('dt')?.textContent === 'Revision')
    expect(row?.querySelector('[data-slot="middle-truncate"]')?.textContent).toContain(revision)
  } finally { act(() => root.unmount()) }
})

it('keeps the first glance concise and puts the complete brief behind an explicit detail door', () => {
  const fixture = runFixture()
  const brief = 'A long task description. '.repeat(80)
  const container = document.createElement('div'), root = createRoot(container)
  try {
    act(() => root.render(<TeamRunFacts input={{ ...fixture, execution: { ...fixture.execution, brief } }} number={1} at={null} />))
    expect(container.textContent).not.toContain(brief)
    expect(container.textContent).not.toContain('Not recorded for this Run:')
    const labels = [...container.querySelectorAll('[aria-label="Team Run facts"] dt')].map(one => one.textContent)
    expect(labels).not.toContain('Run')
    expect(labels).not.toContain('No progress')
    act(() => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Record details'))!.click())
    expect(container.textContent).toContain(brief)
    const cost = [...container.querySelectorAll('[aria-label="Run record details"] [data-slot="summary-item"]')].find(one => one.querySelector('dt')?.textContent === 'Seat cost')
    expect(cost?.querySelector('[data-slot="summary-value"]')?.textContent).toBe('Not recorded')
  } finally { act(() => root.unmount()) }
})


it('shows a human state, actual round progress and explicit unknown elapsed time', () => {
  const fixture = runFixture()
  const execution = { ...fixture.execution, state: 'stalled' as const, startedAt: undefined, rounds: [fixture.execution.rounds[0]!],
    findings: { ...fixture.execution.findings!, budget: { rounds: 4, withoutProgress: 2 }, closedRounds: [], idleRounds: 0 } }
  const container = document.createElement('div'), root = createRoot(container)
  try {
    act(() => root.render(<TeamRunFacts input={{ ...fixture, execution }} number={1} at={null} />))
    const value = (label: string) => [...container.querySelectorAll('[aria-label="Team Run facts"] [data-slot="summary-item"]')].find(one => one.querySelector('dt')?.textContent === label)?.querySelector('[data-slot="summary-value"]')?.textContent
    expect(value('State')).toBe('Needs you')
    expect(value('Progress')).toBe('Round 1 of 4')
    expect(value('Elapsed')).toBe('Time not recorded')
    expect(value('Started')).toBeUndefined()
    expect(value('Rounds')).toBeUndefined()
  } finally { act(() => root.unmount()) }
})

it('keeps execution identity and the chooser available when there are multiple Runs', () => {
  const container = document.createElement('div'), root = createRoot(container)
  try {
    act(() => root.render(<TeamRunFacts input={runFixture()} number={2} chooser={<button>Choose Run</button>} at={null} />))
    const row = [...container.querySelectorAll('[aria-label="Team Run facts"] [data-slot="summary-item"]')].find(one => one.querySelector('dt')?.textContent === 'Run')
    expect(row?.textContent).toContain('Run 2')
    expect(row?.querySelector('button')?.textContent).toBe('Choose Run')
  } finally { act(() => root.unmount()) }
})

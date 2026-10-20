import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { FlowExample } from './FlowExample'
import type { FlowModel } from '../../lib/flow-model'
import { flowModel } from '../../lib/flow-model'
import { examplePaths } from '../../lib/flow-example'
import exampleSheet from './FlowExample.module.css?raw'
import stepSheet from '../ui/flow-step.module.css?raw'
// Parse shipped fixtures through the host grammar; product rendering never imports it.
import { parseFlowPolicy } from '../../../../server/dist/src/flow-policy.js'
vi.mock('./FlowGraph', () => ({ FlowGraph: ({ onSelectRule }: { onSelectRule?: (id: string) => void }) => <div data-slot="example-test-graph"><button onClick={() => onSelectRule?.('handoff')}>Inspect transition</button></div> }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const container = document.createElement('div'); document.body.append(container)
const root = createRoot(container)
afterEach(() => { act(() => root.render(null)); vi.useRealTimers(); vi.restoreAllMocks() })
const model: FlowModel = { name: 'Human handoff', seed: 'work', positions: {}, invalidPositions: false, steps: [
  { id: 'work', name: 'Work', kind: 'agent', line: 'May edit', count: 1, agents: [] },
  { id: 'person', name: 'Person', kind: 'person', line: 'done', count: 1, agents: [] },
], rules: [{ id: 'handoff', on: 'work', to: 'person', word: null, when: 'Whatever the outcome' }] }
const button = (label: string) => [...container.querySelectorAll('button')].find(one => one.textContent === label)!
const shipped = import.meta.glob('../../../../server/flows/*.yml', { eager: true, query: '?raw', import: 'default' })
it('pauses the animated ring paint and relay through Play, Pause and resume', async () => {
  vi.useFakeTimers()
  await act(async () => root.render(<FlowExample model={model} />))
  const example = container.querySelector('[data-slot="flow-example"]')!
  // The ring carrier has no animation: its painted pseudo-element breathes.
  // A pause rule on the carrier alone cannot pause that independent animation.
  expect(stepSheet).toMatch(/\.ring::before\s*\{[^}]*animation:\s*breathe/)
  const sheet = document.createElement('style')
  sheet.textContent = exampleSheet
  document.head.append(sheet)
  try {
    const pauseRules = [...sheet.sheet!.cssRules].filter((rule): rule is CSSStyleRule =>
      rule instanceof CSSStyleRule && rule.style.getPropertyValue('animation-play-state') === 'paused')
    const paused = pauseRules.flatMap(rule => rule.selectorText.split(',').map(selector => selector.trim()))
    expect(paused).toContain('.example[data-playing="false"] [data-slot="flow-ring"]::before')
    expect(paused).toContain('.example[data-playing="false"] [data-slot="flow-baton"]')
  } finally { sheet.remove() }
  expect(example.getAttribute('data-playing')).toBe('false')
  await act(async () => button('Play').click())
  expect(example.getAttribute('data-playing')).toBe('true')
  await act(async () => button('Pause').click())
  expect(example.getAttribute('data-playing')).toBe('false')
  await act(async () => vi.advanceTimersByTime(5000))
  expect(container.textContent).toContain('Example step: Work')
  await act(async () => button('Play').click())
  expect(example.getAttribute('data-playing')).toBe('true')
})
it.each(Object.entries(shipped))('plays every declared illustration path in %s and waits for a person', async (_file, source) => {
  vi.useFakeTimers()
  const parsed = parseFlowPolicy(String(source))
  expect(parsed.problems.filter(problem => problem.level === 'error')).toEqual([])
  if (parsed.document?.format !== 'agents') throw new Error('Expected an Agent-routed Flow')
  const policy = parsed.document.flow, model = flowModel(policy), rounds = policy.budget?.rounds ?? 3
  const paths = examplePaths(model, rounds)
  expect(paths.length).toBeGreaterThan(0)
  await act(async () => root.render(<FlowExample model={model} rounds={rounds} />))
  for (const [index, path] of paths.entries()) {
    const select = container.querySelector('select')
    if (select) await act(async () => { select.value = String(index); select.dispatchEvent(new Event('change', { bubbles: true })) })
    else await act(async () => button('Reset').click())
    expect(path.steps.length).toBeLessThanOrEqual(Math.max(1, Math.min(24, rounds)))
    for (const stepId of path.steps) {
      const step = model.steps.find(one => one.id === stepId)!
      if (step.kind === 'person') {
        expect(container.textContent).toContain('Paused for a person')
        expect(button('Play').disabled).toBe(true)
        const paused = container.textContent
        await act(async () => vi.advanceTimersByTime(5000))
        expect(container.textContent).toBe(paused)
        await act(async () => button('Next').click())
      } else {
        expect(container.textContent).toContain(`Example step: ${step.name}`)
        if (!button('Pause')) await act(async () => button('Play').click())
        await act(async () => vi.advanceTimersByTime(1400))
      }
    }
    expect(container.textContent).toContain('Example finished')
    expect(button('Next').disabled).toBe(true)
  }
})
it('labels local playback and pauses at a person until an explicit Next', async () => {
  vi.useFakeTimers()
  await act(async () => root.render(<FlowExample model={model} />))
  expect(container.textContent).toContain('Example')
  await act(async () => button('Play').click())
  await act(async () => vi.advanceTimersByTime(1400))
  expect(container.textContent).toContain('Paused for a person')
  expect(button('Play').disabled).toBe(true)
  await act(async () => vi.advanceTimersByTime(9000))
  expect(container.textContent).not.toContain('Example finished')
  await act(async () => button('Next').click())
  expect(container.textContent).toContain('Example finished')
  await act(async () => button('Reset').click())
  expect(button('Play').disabled).toBe(false)
})
it('uses explicit stepping under reduced motion', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  await act(async () => root.render(<FlowExample model={model} />))
  expect(button('Play').disabled).toBe(true)
  expect(container.textContent).toContain('Use Next with reduced motion')
  await act(async () => button('Next').click())
  expect(container.textContent).toContain('Paused for a person')
  vi.unstubAllGlobals()
})


it('shows all guards on a selected shared transition and distinguishes their paths', async () => {
  const alternatives = { ...model, rules: [
    { ...model.rules[0]!, word: 'approve', when: 'When every answer says approve' },
    { ...model.rules[0]!, id: 'other', word: 'request-changes', when: 'When any answer says request-changes' },
  ] }
  await act(async () => root.render(<FlowExample model={alternatives} />))
  const labels = [...container.querySelectorAll('option')].map(option => option.textContent)
  expect(new Set(labels).size).toBe(2)
  expect(labels.some(label => label?.includes('approve'))).toBe(true)
  expect(labels.some(label => label?.includes('request-changes'))).toBe(true)
  const guardNotes = () => [...container.querySelectorAll('p')].filter(note => note.textContent?.startsWith('Work → Person:'))
  expect(guardNotes()).toHaveLength(0)
  await act(async () => button('Inspect transition').click())
  expect(guardNotes().map(note => note.textContent)).toEqual([
    'Work → Person: When every answer says approve.',
    'Work → Person: When any answer says request-changes.',
  ])
})

it('shows every guard when playback reaches a shared transition without a selection event', async () => {
  const alternatives = { ...model, rules: [
    { ...model.rules[0]!, word: 'approve', when: 'When every answer says approve' },
    { ...model.rules[0]!, id: 'other', word: 'request-changes', when: 'When any answer says request-changes' },
  ] }
  await act(async () => root.render(<FlowExample model={alternatives} />))
  await act(async () => button('Next').click())
  const notes = [...container.querySelectorAll('p')].filter(note => note.textContent?.startsWith('Work → Person:'))
  expect(notes.map(note => note.textContent)).toEqual([
    'Work → Person: When every answer says approve.',
    'Work → Person: When any answer says request-changes.',
  ])
})

import { useEffect, useRef, type ReactNode } from 'react'
import type { FlowExecution, Intent } from '@harnessdesk/protocol'
import { AbandonCard } from '../components/AbandonCard'
import { RunWorkspace } from '../components/RunWorkspace'
import { runTimeline } from '../lib/run-timeline'
import { runFixture } from './run-view-fixture'

/**
 * A Run's controls, drawn by the production inspector and the production
 * question: a card that has not finished offers Abandon card…, and a person's
 * step offers its words. Placeholder names and data only.
 */
export const RUN_CONTROL_STATES = ['abandon', 'person-answer', 'person-review', 'narrow'] as const
export type RunControlScene = typeof RUN_CONTROL_STATES[number]

/** What the question says first, by what the Flow does after the card. */
export const ABANDON_VARIANTS = ['opens', 'ends', 'waits', 'refused'] as const
export type AbandonVariant = typeof ABANDON_VARIANTS[number]

const REFUSAL = 'There is no intent #4 on this board.'
const reviewer = { id: 'review', on: 'writer', then: { role: 'reviewer', title: 'Review the change' } }

type Press = (frame: HTMLElement) => HTMLElement | undefined
/** A button of this frame, never one of another frame's. */
const labelled = (label: string): Press => frame => [...frame.querySelectorAll('button')].find(one => one.textContent === label)
/** A button of the question, which is portalled out of its frame: only one is open at a time. */
const asked = (label: string): Press => () => [...document.querySelectorAll('[role="alertdialog"] button')].find(one => one.textContent === label) as HTMLElement | undefined
const inside = (selector: string): Press => frame => frame.querySelector<HTMLElement>(selector) ?? undefined

/**
 * Presses made once the frame has drawn, as a person would make them, so the frame shows the production control's
 * own state and not a picture of it.
 */
const Pressed = ({ steps, children }: { steps: readonly Press[]; children: ReactNode }) => {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let step = 0
    let timer = window.setTimeout(function press() {
      const target = box.current ? steps[step]?.(box.current) : undefined
      if (!target) return
      target.click()
      step += 1
      if (step < steps.length) timer = window.setTimeout(press, 50)
    }, 50)
    return () => window.clearTimeout(timer)
  }, [steps])
  return <div ref={box} className="contents">{children}</div>
}

const OPEN_DETAIL: readonly Press[] = [inside('[data-row="person-4-4"]')]
const OPEN_QUESTION: readonly Press[] = [labelled('Abandon card…')]
const REFUSED_QUESTION: readonly Press[] = [labelled('Abandon card…'), asked('Abandon card')]

export const RunControlExample = ({ scene }: { scene: RunControlScene }) => {
  const person = scene !== 'abandon'
  const source = runFixture(person ? 'person' : 'running')
  const flow = source.execution.document.flow as unknown as Record<string, unknown>
  const rules = scene === 'person-review'
    ? [{ id: 'land', on: 'person', when: { every: ['approved'], evidence: [{ review: 'approved' }] }, then: { role: 'writer', title: 'Merge' } }]
    : scene === 'abandon' ? [reviewer] : [{ id: 'ship', on: 'person', when: { every: ['approved'] }, then: { role: 'writer', title: 'Land the change' } }]
  const execution = { ...source.execution, base: { remote: 'origin', branch: 'main', at: 'abc123' },
    document: { ...source.execution.document, flow: { ...flow, rules } } } as unknown as FlowExecution
  const input = { ...source, execution, cards: source.cards.map(card => card.id === 4
    ? { ...card, detail: person ? 'Decide whether the retry change ships, once the review is in.' : 'Add the retry ceiling to the checkout call.' } : card) }
  const workspace = (
    <RunWorkspace model={runTimeline(input)} number={1} selectedRow={person ? 'person-4-4' : 'card-4-4'} onSelect={() => {}}
      inspector={{ input, findingsRead: undefined,
        seats: [{ id: 'seat-0', name: 'Alpha', cost: { unit: 'turns', value: 4, estimated: false }, onOpen: () => {} }],
        onAbandon: async () => {}, onAnswer: async () => {}, onOpenBoard: () => {} }} />
  )
  // At a narrow width a selection pushes the detail over the timeline: open it as a person would.
  return scene === 'narrow' ? <Pressed steps={OPEN_DETAIL}>{workspace}</Pressed> : workspace
}

/** The question itself, opened as a person opens it, for one way the Flow can answer it. */
export const AbandonDialogExample = ({ variant }: { variant: AbandonVariant }) => {
  const source = runFixture('running')
  const waits = variant === 'waits'
  const flow = source.execution.document.flow as unknown as Record<string, unknown>
  const rules = variant === 'ends' ? [{ id: 'ship', on: 'writer', when: { every: ['published'] }, then: { role: 'reviewer', title: 'Review the change' } }] : [reviewer]
  const cards: Intent[] = waits ? [...source.cards, { ...source.cards[3]!, id: 5, title: 'Add the ceiling to the order page' }] : source.cards
  const execution = { ...source.execution,
    rounds: source.execution.rounds.map(round => waits && round.n === 4 ? { ...round, cards: [4, 5] } : round),
    document: { ...source.execution.document, flow: { ...flow, rules } } } as unknown as FlowExecution
  const card = { ...cards.find(one => one.id === 4)!, role: 'writer' }
  const onAbandon = variant === 'refused' ? async () => { throw new Error(REFUSAL) } : async () => {}
  return (
    <Pressed steps={variant === 'refused' ? REFUSED_QUESTION : OPEN_QUESTION}>
      <AbandonCard execution={execution} cards={cards} card={card} holder="Alpha" onAbandon={onAbandon} />
    </Pressed>
  )
}

const frame = (scene: RunControlScene) => scene === 'narrow' ? 'flex h-144 max-w-sm flex-col' : 'flex h-144 flex-col'

/** The control that opens the question, live: a dialog takes the window, so the board shows one only when pressed. */
const AbandonQuestionControl = () => {
  const source = runFixture('running')
  const flow = source.execution.document.flow as unknown as Record<string, unknown>
  const execution = { ...source.execution, document: { ...source.execution.document, flow: { ...flow, rules: [reviewer] } } } as unknown as FlowExecution
  return <AbandonCard execution={execution} cards={source.cards} card={{ ...source.cards[3]!, role: 'writer' }} holder="Alpha" onAbandon={async () => {}} />
}

export const RunControlsBoard = () => (
  <div className="flex flex-col gap-4">
    {RUN_CONTROL_STATES.map(scene => <section key={scene} data-catalog-state={scene} className={frame(scene)}><RunControlExample scene={scene} /></section>)}
    <section data-catalog-state="abandon-question" className="p-4"><AbandonQuestionControl /></section>
  </div>
)

/** The preview's frames: the controls, and the question for the variant a query names (one at a time, as a dialog is). */
export const RunControlsFrames = ({ variant }: { variant: AbandonVariant | null }) => (
  <div className="flex flex-col gap-4 p-4">
    {RUN_CONTROL_STATES.map(scene => <section key={scene} id={`run-controls-${scene}`} className={frame(scene)}><RunControlExample scene={scene} /></section>)}
    {variant && <section id={`run-controls-abandon-${variant}`}><AbandonDialogExample variant={variant} /></section>}
  </div>
)

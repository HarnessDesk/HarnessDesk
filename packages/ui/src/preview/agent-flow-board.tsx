import { AgentFlowCard, AgentLanes, Text, type AgentFlowChild, type AgentLane } from '../design'

/**
 * The `AgentFlow` pattern alone, for the design explorer's board.
 *
 * It lives apart from `frames-subagent-flow.tsx` on purpose: that file draws
 * its frames with `Frame` from `./main`, the preview page's entry, which mounts
 * React when it loads. Anything `design.html` imports must never reach it, or
 * the explorer mounts twice on one container.
 */
const CHILDREN: readonly AgentFlowChild[] = [
  { id: 'trace', name: 'Trace the retry', role: 'explorer', phase: 'done', phaseWord: 'Done', prompt: 'Read the checkout retry path and say where the second attempt starts.', facts: 'sol · 1m 52s · 18.4K tokens', onOpen: () => {} },
  { id: 'a', name: 'Provider A check', role: 'worker', phase: 'working', phaseWord: 'Working', prompt: 'Run the retry tests against provider A.', facts: 'sol · 4m 8s · 9.2K tokens', onOpen: () => {} },
  { id: 'b', name: 'Provider B check — a long name that has to give way to its facts', role: 'worker', phase: 'working', phaseWord: 'Working', facts: 'sol · 4m 6s', onOpen: () => {} },
]
const FINISHED_CHILDREN: readonly AgentFlowChild[] = [
  { id: 'r1', name: 'Accessibility review', role: 'reviewer', phase: 'done', phaseWord: 'Done', facts: '3m 8s · 31K tokens' },
  { id: 'r2', name: 'Performance review', role: 'reviewer', phase: 'failed', phaseWord: 'Failed', facts: '58s · 12.5K tokens' },
  { id: 'r3', name: 'Copy review', phase: 'stopped', phaseWord: 'Stopped', facts: '12s' },
]
const T0 = 0
const LANES: readonly AgentLane[] = [
  { id: 'trace', name: 'Trace the retry', phase: 'done', phaseWord: 'Done · 1m 52s', start: T0, end: T0 + 121_000, onPick: () => {} },
  { id: 'a', name: 'Provider A check', phase: 'working', phaseWord: 'Working · 4m 8s', start: T0 + 4_000, end: T0 + 252_000, onPick: () => {} },
  { id: 'b', name: 'Provider B check', phase: 'working', phaseWord: 'Working · 4m 6s', start: T0 + 6_000, end: T0 + 252_000 },
  { id: 'c', name: 'Lint', phase: 'failed', phaseWord: 'Failed · 2s', start: T0 + 30_000, end: T0 + 32_000 },
]

/** The pattern with every phase, a long name, a fan-in line and a clock: `AgentFlow` on the explorer. */
export const AgentFlowBoard = () => (
  <div className="flex max-w-2xl flex-col gap-8">
    <section data-catalog-state="working" className="flex flex-col gap-2">
      <Text role="section">Started three; the agent waits on two</Text>
      <AgentFlowCard title="Started 3 sub-agents" summary={['2 working', '1 done']} facts="4m 12s · 33.7K tokens" working trouble={false} waiting="Waiting for 2 agents" children={CHILDREN} />
    </section>
    <section data-catalog-state="default" className="flex flex-col gap-2">
      <Text role="section">All finished: done, failed and stopped</Text>
      <AgentFlowCard title="Started 3 sub-agents" summary={['1 done', '1 failed', '1 stopped']} facts="3m 8s · 43.5K tokens" working={false} trouble children={FINISHED_CHILDREN} />
    </section>
    <section data-catalog-state="populated" className="flex flex-col gap-2">
      <Text role="section">Who ran when, on one clock</Text>
      <AgentLanes lanes={LANES} from={T0} to={T0 + 252_000} startLabel="0s" endLabel="4m 12s · now" />
    </section>
  </div>
)

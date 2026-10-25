import type { LeadAcceptanceContract, LeadOrigin } from '@harnessdesk/protocol'
import { Timeline, TimelineItem } from '../ui/timeline'
import { Text } from './Settings'
import { Button } from '../ui/button'
import { openExternal } from '../../lib/desktop'

const roles = new Map([['implement', 'write'], ['review', 'review']])
const work = (step: LeadAcceptanceContract['steps'][number]) => step.assignments
  .map(assignment => roles.get(assignment.role) ?? assignment.role.replace(/[-_]+/g, ' '))
  .filter((word, index, words) => word !== words[index - 1]).join(', then ')

/** An approved plan's linear flow in reading order. The Timeline owns the
 * decorative connectors; role labels describe responsibility without naming
 * a runtime. Labels are text, wrap whole, and cannot introduce markup. */
export const LeadPlanFlow = ({ steps, origin }: {
  readonly steps: LeadAcceptanceContract['steps']
  readonly origin?: LeadOrigin | null
}) => <div data-slot="lead-plan-flow" className="min-w-0 break-words [overflow-wrap:anywhere]">
  {origin && <Text as="div" role="meta">{origin.url && /^https?:\/\//i.test(origin.url) ? <Button variant="link" size="inline-link" onClick={() => openExternal(origin.url!)}>{`From: ${origin.event.replace(/-/g, ' ')} on ${origin.subject}`}</Button> : `From: ${origin.event.replace(/-/g, ' ')} on ${origin.subject}`}</Text>}
  <Timeline aria-label="Plan flow">
    {steps.map(step => <TimelineItem key={step.id} state="pending" title={`${step.title} — ${work(step)}`} />)}
    <TimelineItem state="pending" title="Approve to start" />
  </Timeline>
</div>

import type { LeadOpeningJob } from '../lib/lead-opening'
import { Button, Row, Rows } from '../design'
import { sanitizeText } from '../lib/sanitize'

/** No model call on display. Start enters the ordinary goal-to-plan path. */
export const LeadOpening = ({ jobs, pending, onStart }: { readonly jobs: readonly LeadOpeningJob[]; readonly pending: boolean; readonly onStart: (goal: string) => void }) => jobs.length ? <Rows>
  {jobs.map(job => <Row key={job.id} title={sanitizeText(job.title)} tooltip={sanitizeText(job.goal)} control={<Button variant="outline" disabled={pending} aria-label={`Start ${sanitizeText(job.title)}`} onClick={() => onStart(job.goal)}>Start</Button>} />)}
</Rows> : null

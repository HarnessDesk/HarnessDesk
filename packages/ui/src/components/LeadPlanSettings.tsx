import { useEffect, useState } from 'react'
import { LEAD_SCHEDULE_LIMITS, parseLeadMemory, parseLeadSchedule, type LeadCard, type LeadMemory, type LeadMemoryItem, type LeadSchedule, type LeadScheduledTask, type LeadTaskRepeat } from '@harnessdesk/protocol'
import { Banner, Button, Chip, FormStack, InlineParts, Input, NativeSelect, Row, Rows, Section, Switch, Text, Textarea } from '../design'
import { useStore } from '../state/context'
import { useDestinationActive } from '../panels/destination-page'
import { leadRefusalText } from './lead-refusals'

const REPEATS: Record<LeadTaskRepeat, string> = { day: 'Every day', weekdays: 'Weekdays', mondays: 'Mondays', fridays: 'Fridays' }
const newId = () => `task-${crypto.randomUUID()}`

/** Which kept lines the open plan names: a plan cites line N as "(mN)" in a step's title. */
export const leadCitedLines = (cards: readonly LeadCard[] = []): ReadonlySet<number> => {
  const text = JSON.stringify(cards.filter(card => card.type === 'plan'))
  return new Set([...text.matchAll(/\(m(\d{1,3})\)/g)].map(match => Number(match[1])))
}

export const LeadScheduleSettings = ({ label, schedule, pending, save }: {
  readonly label: string
  readonly schedule: LeadSchedule
  readonly pending: boolean
  readonly save: (schedule: LeadSchedule) => void
}) => {
  const [draft, setDraft] = useState<{ title: string; goal: string; every: LeadTaskRepeat; at: string } | null>(null)
  const put = (tasks: readonly LeadScheduledTask[], quiet = schedule.quiet) => save({ version: 1, tasks, quiet })
  const valid = draft && draft.title.trim() && draft.goal.trim() && /^\d\d:\d\d$/.test(draft.at)
  return <>
    <Section title="Scheduled tasks">
      <Text as="p" role="muted">{`Each one opens a new goal at its time when ${label} has nothing open, and starts at a plan for you to approve.`}</Text>
      <Rows>
        {schedule.tasks.map(task => <Row key={task.id} title={task.title} tooltip={task.goal} desc={`${REPEATS[task.every]} · ${task.at}`}
          control={<InlineParts>
            <Switch aria-label={`Run ${task.title}`} checked={task.enabled} disabled={pending} onCheckedChange={enabled => put(schedule.tasks.map(one => one.id === task.id ? { ...one, enabled } : one))} />
            <Button variant="quiet" disabled={pending} onClick={() => put(schedule.tasks.filter(one => one.id !== task.id))}>Remove</Button>
          </InlineParts>} />)}
        {draft ? <Row title="New task" desc={<FormStack>
          <Input aria-label="Task name" placeholder="Name" value={draft.title} maxLength={80} onChange={event => setDraft({ ...draft, title: event.target.value })} />
          <Textarea aria-label="Task goal" placeholder={`What ${label} should get done`} value={draft.goal} maxLength={2000} onChange={event => setDraft({ ...draft, goal: event.target.value })} />
          <InlineParts>
            <NativeSelect aria-label="Repeats" value={draft.every} onChange={event => setDraft({ ...draft, every: event.target.value as LeadTaskRepeat })}>
              {(Object.keys(REPEATS) as LeadTaskRepeat[]).map(every => <option key={every} value={every}>{REPEATS[every]}</option>)}
            </NativeSelect>
            <Input aria-label="Time" type="time" value={draft.at} onChange={event => setDraft({ ...draft, at: event.target.value })} />
          </InlineParts>
        </FormStack>} control={<InlineParts>
          <Button disabled={pending || !valid} onClick={() => { if (!draft || !valid) return
            put([...schedule.tasks, { id: newId(), title: draft.title.trim(), goal: draft.goal.trim(), every: draft.every, at: draft.at, enabled: true, lastRunAt: null }]); setDraft(null) }}>Add</Button>
          <Button variant="quiet" onClick={() => setDraft(null)}>Cancel</Button>
        </InlineParts>} />
          : <Row title={schedule.tasks.length ? null : 'No scheduled tasks'} control={<Button variant="outline" disabled={pending || schedule.tasks.length >= LEAD_SCHEDULE_LIMITS.tasks}
            onClick={() => setDraft({ title: '', goal: '', every: 'weekdays', at: '09:00' })}>Add task…</Button>} />}
      </Rows>
    </Section>
    <Section title="Quiet hours">
      <Rows>
        <Row title="Hold scheduled tasks"
          control={<Switch aria-label="Quiet hours" checked={!!schedule.quiet} disabled={pending} onCheckedChange={on => put(schedule.tasks, on ? { from: '22:00', to: '07:00' } : null)} />} />
        {schedule.quiet && <>
          <Row title="Starts" control={<Input aria-label="Quiet hours start" type="time" value={schedule.quiet.from} disabled={pending} onChange={event => event.target.value && put(schedule.tasks, { ...schedule.quiet!, from: event.target.value })} />} />
          <Row title="Ends" control={<Input aria-label="Quiet hours end" type="time" value={schedule.quiet.to} disabled={pending} onChange={event => event.target.value && put(schedule.tasks, { ...schedule.quiet!, to: event.target.value })} />} />
        </>}
      </Rows>
    </Section>
  </>
}

export const LeadMemorySettings = ({ label, memory, cited, pending, save }: {
  readonly label: string
  readonly memory: LeadMemory
  readonly cited: ReadonlySet<number>
  readonly pending: boolean
  readonly save: (memory: LeadMemory) => void
}) => {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const put = (items: readonly LeadMemoryItem[]) => save({ version: 1, items })
  const set = (id: string, change: Partial<LeadMemoryItem>) => put(memory.items.map(item => item.id === id ? { ...item, ...change } : item))
  const kept = memory.items.filter(item => item.state === 'kept'), suggested = memory.items.filter(item => item.state === 'suggested')
  return <Section title="What I remember">
    <Text as="p" role="muted">{`${label} is told the kept lines at the start of each goal, and a plan names the line it follows.`}</Text>
    <Rows>
      {kept.map((item, index) => editing?.id === item.id
        ? <Row key={item.id} title={<Input aria-label="Remembered line" value={editing.text} maxLength={400} autoFocus onChange={event => setEditing({ id: item.id, text: event.target.value })} />}
          control={<InlineParts>
            <Button disabled={pending || !editing.text.trim()} onClick={() => { set(item.id, { text: editing.text.trim() }); setEditing(null) }}>Save</Button>
            <Button variant="quiet" onClick={() => setEditing(null)}>Cancel</Button>
          </InlineParts>} />
        : <Row key={item.id} title={item.text} titleChip={cited.has(index + 1) ? <Chip tone="info">Used in this plan</Chip> : undefined}
          control={<InlineParts>
            <Button variant="quiet" disabled={pending} onClick={() => setEditing({ id: item.id, text: item.text })}>Edit</Button>
            <Button variant="quiet" disabled={pending} onClick={() => put(memory.items.filter(one => one.id !== item.id))}>Forget</Button>
          </InlineParts>} />)}
      {suggested.map(item => <Row key={item.id} title={item.text} titleChip={<Chip tone="neutral">Suggested</Chip>}
        control={<InlineParts>
          <Button variant="outline" disabled={pending} onClick={() => set(item.id, { state: 'kept' })}>Keep</Button>
          <Button variant="quiet" disabled={pending} onClick={() => put(memory.items.filter(one => one.id !== item.id))}>Discard</Button>
        </InlineParts>} />)}
      {!memory.items.length && <Row title="Nothing yet" />}
    </Rows>
  </Section>
}

/** Settings › Lead below the allowances: the person's own files, saved whole on each change. */
export const LeadPlanSettingsSection = ({ label, cards }: { readonly label: string; readonly cards?: readonly LeadCard[] }) => {
  const store = useStore(), active = useDestinationActive()
  const [schedule, setSchedule] = useState<LeadSchedule | null>(null), [memory, setMemory] = useState<LeadMemory | null>(null)
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!active) return
    void Promise.all([store.lead.readSchedule(), store.lead.readMemory()]).then(([schedule, memory]) => { setSchedule(parseLeadSchedule(schedule)); setMemory(parseLeadMemory(memory)) })
      .catch(() => { /* A host without these files shows no section; the rest of Settings › Lead stands. */ })
  }, [active, store])
  const run = <T,>(write: () => Promise<T>, apply: (value: T) => void) => {
    setPending(true); setError(null)
    void write().then(apply, error => setError(leadRefusalText(error))).finally(() => setPending(false))
  }
  return <>
    {error && <Banner role="alert" tone="warning">{error}</Banner>}
    {schedule && <LeadScheduleSettings label={label} schedule={schedule} pending={pending} save={next => run(() => store.lead.updateSchedule(next), value => setSchedule(parseLeadSchedule(value)))} />}
    {memory && <LeadMemorySettings label={label} memory={memory} cited={leadCitedLines(cards)} pending={pending} save={next => run(() => store.lead.updateMemory(next), value => setMemory(parseLeadMemory(value)))} />}
  </>
}

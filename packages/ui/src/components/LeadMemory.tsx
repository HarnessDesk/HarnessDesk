import { useEffect, useState, useSyncExternalStore } from 'react'
import { LEAD_MEMORY_LIMITS, type LeadCard, type LeadMemoryCandidate, type LeadMemoryChange, type LeadMemoryEntry, type LeadMemoryVersionSummary, type LeadMemoryView, type LeadMessage } from '@harnessdesk/protocol'
import { Banner, Button, Chip, ConfirmDialog, InlineParts, Input, Row, Rows, Section, SectionHead, Switch, Text } from '../design'
import { useDestinationActive } from '../panels/destination-page'
import { useStore } from '../state/context'
import { sanitizeText } from '../lib/sanitize'
import { leadRefusalText } from './lead-refusals'

/**
 * Where each proposal waiting for the person sits in the Lead's thread: under the first Lead reply after the journal
 * position it was proposed at, or under the latest reply when none came after it. Proposed again while it waits, the
 * desk moves that position forward, so the same chip shows under the newer reply instead of a second copy. With no Lead reply at all it sits
 * nowhere in the thread; Settings › Lead › Memory still lists it. The Lead's settings proposals are placed the same way.
 */
export const leadMemoryPlacement = <T extends { readonly afterSeq: number } = LeadMemoryCandidate>(messages: readonly LeadMessage[], inbox: readonly T[]): ReadonlyMap<string, readonly T[]> => {
  const replies = messages.filter(message => message.role === 'assistant')
  const placed = new Map<string, T[]>()
  if (!replies.length) return placed
  for (const candidate of inbox) {
    const reply = replies.find(message => message.revision > candidate.afterSeq) ?? replies.at(-1)!
    placed.set(reply.id, [...placed.get(reply.id) ?? [], candidate])
  }
  return placed
}

/** The plan's citations of memory: "(m2)" names entry m2. */
export const leadCitedEntries = (cards: readonly LeadCard[] = []): ReadonlySet<string> => {
  const text = JSON.stringify(cards.filter(card => card.type === 'plan'))
  return new Set([...text.matchAll(/\((m\d{1,4})\)/g)].map(match => match[1]!))
}

const KIND: Record<LeadMemoryEntry['kind'], string> = { preference: 'Preference', fact: 'Fact', lesson: 'Lesson', rule: 'Rule' }

/** Keep, Edit or No on one proposal, under the reply it came with or in Settings. Edited text is the person's. */
const ProposalRow = ({ candidate, pending, change }: { readonly candidate: LeadMemoryCandidate; readonly pending: boolean; readonly change: (change: LeadMemoryChange) => void }) => {
  const [editing, setEditing] = useState<string | null>(null)
  return editing !== null
    ? <Row title={<Input aria-label="Note to keep" value={editing} maxLength={LEAD_MEMORY_LIMITS.textChars} autoFocus onChange={event => setEditing(event.target.value)} />}
      control={<InlineParts>
        <Button disabled={pending || !editing.trim()} onClick={() => { change({ action: 'keep', id: candidate.id, text: editing.trim() }); setEditing(null) }}>Keep</Button>
        <Button variant="quiet" onClick={() => setEditing(null)}>Cancel</Button>
      </InlineParts>} />
    : <Row title={sanitizeText(candidate.text)} titleChip={<InlineParts><Chip variant="quiet" tone="neutral">{KIND[candidate.kind]}</Chip>
        {candidate.askedAgainAt !== undefined && <Chip variant="quiet" tone="neutral" title="Proposed again while it waited for you; still one note">Asked again</Chip>}</InlineParts>}
      control={<InlineParts>
        <Button variant="outline" disabled={pending} title="Keep this note in memory" onClick={() => change({ action: 'keep', id: candidate.id })}>Keep</Button>
        <Button variant="quiet" disabled={pending} onClick={() => setEditing(candidate.text)}>Edit</Button>
        <Button variant="quiet" disabled={pending} title="Not offered again" onClick={() => change({ action: 'dismiss', id: candidate.id })}>No</Button>
      </InlineParts>} />
}

/** The proposals a reply carries, drawn under it in the thread. */
export const LeadMemoryProposals = ({ candidates }: { readonly candidates: readonly LeadMemoryCandidate[] }) => {
  const store = useStore()
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null)
  const change = (value: LeadMemoryChange) => {
    setPending(true); setError(null)
    void store.lead.changeMemory(value).catch(failure => setError(leadRefusalText(failure))).finally(() => setPending(false))
  }
  return <div data-slot="lead-memory-proposals">
    <Rows aria-label="Keep in memory?">{candidates.map(candidate => <ProposalRow key={candidate.id} candidate={candidate} pending={pending} change={change} />)}</Rows>
    {error && <Text as="p" role="muted">{error}</Text>}
  </div>
}

const kb = (bytes: number) => (Math.round(bytes / 102.4) / 10).toFixed(1)
const historyTitle = (item: LeadMemoryVersionSummary, label: string): string => {
  if (item.tidy) return `Tidy · ${[item.tidy.merged && `${item.tidy.merged} merged`, item.tidy.replaced && `${item.tidy.replaced} replaced`, item.tidy.archived && `${item.tidy.archived} to Archive`].filter(Boolean).join(', ') || 'no change'}`
  const counts = [item.added && `${item.added} added`, item.changed && `${item.changed} changed`, item.removed && `${item.removed} removed`].filter(Boolean).join(', ') || 'no change'
  const who = item.by === 'person' ? 'You' : item.by === 'lead' ? label : item.by === 'undo' ? 'Undo' : 'Carried over'
  return `${who} · ${counts}`
}
const when = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** What Forget does, said before it is done. Pinned by the desk's own test of Forget (packages/server/test/lead-memory.test.ts)
 * and by docs/data-boundaries.md: a passage that says the note in other words is not found, and the Lead's journal (with its sealed segments)
 * keeps its own record, so neither is promised. */
export const leadMemoryForgetText = (label: string): string => 'Removes the note, every saved version of it and any passage of the conversation that quotes it, so search cannot find them. ' +
  `The conversation it came from stays, and so does the record in ${label}'s journal on this desk. This cannot be undone.`
export const leadMemoryForgetAllText = (label: string): string => `Removes every note, every proposal and every saved version, and empties the copy of the conversation ${label} searches. ` +
  `${label}'s journal on this desk keeps its record. This cannot be undone.`

/** One kept entry: its words, whose they are, and what can be done with it. */
const EntryRow = ({ entry, label, cited, pending, change }: { readonly entry: LeadMemoryEntry; readonly label: string; readonly cited: boolean; readonly pending: boolean; readonly change: (change: LeadMemoryChange) => void }) => {
  const [editing, setEditing] = useState<string | null>(null), [forgetting, setForgetting] = useState(false)
  if (editing !== null) return <Row title={<Input aria-label="Remembered note" value={editing} maxLength={LEAD_MEMORY_LIMITS.textChars} autoFocus onChange={event => setEditing(event.target.value)} />}
    control={<InlineParts>
      <Button disabled={pending || !editing.trim()} onClick={() => { change({ action: 'edit', id: entry.id, text: editing.trim() }); setEditing(null) }}>Save</Button>
      <Button variant="quiet" onClick={() => setEditing(null)}>Cancel</Button>
    </InlineParts>} />
  const chip = cited ? <Chip tone="info">Used in this plan</Chip> : entry.by === 'lead' ? <Chip variant="quiet" tone="neutral">{`${label}'s note`}</Chip> : undefined
  return <><Row title={entry.text} titleChip={chip} tooltip={`${entry.id} · ${KIND[entry.kind]}`}
    control={<InlineParts>
      <Button variant="quiet" disabled={pending} onClick={() => setEditing(entry.text)}>Edit</Button>
      {entry.tier === 'core'
        ? <Button variant="quiet" disabled={pending} title="Searched when needed instead of read every time" onClick={() => change({ action: 'move', id: entry.id, tier: 'archive' })}>Archive</Button>
        : <Button variant="quiet" disabled={pending} title="Read at the start of every conversation" onClick={() => change({ action: 'move', id: entry.id, tier: 'core' })}>Move to Core</Button>}
      <Button variant="quiet" disabled={pending} title="Removed here and from every saved version" onClick={() => setForgetting(true)}>Forget</Button>
    </InlineParts>} />
    {forgetting && <ConfirmDialog title="Forget this note?" confirmLabel="Forget" cancelLabel="Keep note" tone="destructive" busy={pending}
      onConfirm={() => { change({ action: 'forget', id: entry.id }); setForgetting(false) }} onCancel={() => setForgetting(false)}>
      <Text role="prose">{leadMemoryForgetText(label)}</Text>
    </ConfirmDialog>}
  </>
}

/** Settings › Lead › Memory: what the Lead reads every time, what it searches, what waits for you, and every change. */
export const LeadMemorySection = ({ label, cards }: { readonly label: string; readonly cards?: readonly LeadCard[] }) => {
  const store = useStore(), active = useDestinationActive()
  const lead = useSyncExternalStore(store.lead.subscribe, () => store.lead.state)
  const view: LeadMemoryView | null = lead.memory ?? null
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(''), [forgetAll, setForgetAll] = useState(false)
  useEffect(() => { if (active) void store.lead.readMemoryView().catch(failure => setError(leadRefusalText(failure))) }, [active, store])
  const change = (value: LeadMemoryChange) => {
    setPending(true); setError(null)
    void store.lead.changeMemory(value).catch(failure => setError(leadRefusalText(failure))).finally(() => setPending(false))
  }
  if (!view) return error ? <Section title="Memory"><Text role="muted">{error}</Text></Section> : null
  const cited = leadCitedEntries(cards)
  const exportView = () => {
    const blob = new Blob([JSON.stringify({ version: 1, core: view.core, archive: view.archive }, null, 2)], { type: 'application/json' })
    const link = document.createElement('a'), url = URL.createObjectURL(blob)
    link.href = url; link.download = 'lead-memory.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  const history = view.history.slice(0, 8)
  return <Section title="Memory" action={<InlineParts>
      <Button size="sm" variant="outline" disabled={!view.core.length && !view.archive.length} onClick={exportView}>Export</Button>
      <Button size="sm" variant="outline" disabled={pending || !view.core.length && !view.archive.length && !view.inbox.length && !view.history.length} onClick={() => setForgetAll(true)}>Forget all</Button>
    </InlineParts>}>
    {view.fault && <Banner role="alert" tone="danger">{`${label} is not reading this list. The desk could not hand over the latest change, so ${label} still reads the version before it.`}</Banner>}
    {error && <Banner role="alert" tone="warning">{error}</Banner>}
    <Text as="p" role="muted">{`${label} reads Core at the start of each conversation and searches Archive when it needs to. Your notes are never changed by ${label}.`}</Text>
    <Rows>
      <Row title={`Keep ${label}'s notes without asking`} desc="Facts and lessons skip To review. Preferences still wait for you."
        control={<Switch aria-label={`Keep ${label}'s notes without asking`} checked={view.auto} disabled={pending} onCheckedChange={on => change({ action: 'auto', on })} />} />
      <Row title={<Input aria-label="New note" placeholder="Add a note" value={adding} maxLength={LEAD_MEMORY_LIMITS.textChars} onChange={event => setAdding(event.target.value)} />}
        control={<Button variant="outline" disabled={pending || !adding.trim()} onClick={() => { change({ action: 'add', text: adding.trim(), kind: 'preference' }); setAdding('') }}>Add</Button>} />
    </Rows>
    {view.inbox.length > 0 && <>
      <SectionHead level="label" name="To review" />
      <Rows>{view.inbox.map(candidate => <ProposalRow key={candidate.id} candidate={candidate} pending={pending} change={change} />)}</Rows>
    </>}
    <SectionHead level="label" name="Core" action={<Chip variant="quiet" tone={view.coreBytes > LEAD_MEMORY_LIMITS.coreBytes * 0.9 ? 'warning' : 'neutral'}>{`${kb(view.coreBytes)} of ${kb(LEAD_MEMORY_LIMITS.coreBytes)} KB`}</Chip>} />
    <Rows>
      {view.core.map(entry => <EntryRow key={entry.id} entry={entry} label={label} cited={cited.has(entry.id)} pending={pending} change={change} />)}
      {!view.core.length && <Row title="Nothing kept yet" />}
    </Rows>
    {view.archive.length > 0 && <>
      <SectionHead level="label" name="Archive" />
      <Rows>{view.archive.map(entry => <EntryRow key={entry.id} entry={entry} label={label} cited={cited.has(entry.id)} pending={pending} change={change} />)}</Rows>
    </>}
    {history.length > 0 && <>
      <SectionHead level="label" name="History" />
      <Rows>{history.map(item => <Row key={item.version} title={historyTitle(item, label)} titleChip={item.undone ? <Chip variant="quiet" tone="neutral">Undone</Chip> : undefined} tooltip={when(item.at)}
        control={item.undoable && !item.undone ? <Button variant="quiet" disabled={pending} onClick={() => change({ action: 'undo', version: item.version })}>Undo</Button> : undefined} />)}</Rows>
    </>}
    {forgetAll && <ConfirmDialog title="Forget everything?" confirmLabel="Forget all" cancelLabel="Keep memory" tone="destructive" busy={pending}
      onConfirm={() => { change({ action: 'forget-all' }); setForgetAll(false) }} onCancel={() => setForgetAll(false)}>
      <Text role="prose">{leadMemoryForgetAllText(label)}</Text>
    </ConfirmDialog>}
  </Section>
}

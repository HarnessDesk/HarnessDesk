import { useEffect, useState } from 'react'
import { LEAD_CHECKPOINT_SECTIONS, parseLeadContextFacts, type LeadCheckpointPerson, type LeadContextCheckpoint, type LeadContextFacts, type LeadMessage } from '@harnessdesk/protocol'
import { Banner, Button, Chip, Dialog, Marker, MarkerContent, Row, Rows, Section, Text } from '../design'
import { useDestinationActive } from '../panels/destination-page'
import { sanitizeText } from '../lib/sanitize'
import { formatAge } from '../lib/usage'
import { useStore } from '../state/context'
import { leadRefusalText } from './lead-refusals'

type Read = { readonly state: 'reading' } | { readonly state: 'shown'; readonly checkpoint: LeadContextCheckpoint } | { readonly state: 'gone' } | { readonly state: 'refused'; readonly error: string }

/**
 * Where the desk summarised the Lead's conversation: a rule across the thread, the words the person read above it
 * kept. View reads what replaced the earlier part, which the model wrote, so it is sanitised like any agent output.
 */
export const LeadCheckpointNotice = ({ checkpoint }: { readonly checkpoint: NonNullable<LeadMessage['checkpoint']> }) => {
  const store = useStore()
  const [read, setRead] = useState<Read | null>(null)
  const view = () => {
    setRead({ state: 'reading' })
    void store.lead.readContext().then(parseLeadContextFacts).then(facts => {
      const found = facts.checkpoints.find(one => one.id === checkpoint.id)
      setRead(found?.text ? { state: 'shown', checkpoint: found } : { state: 'gone' })
    }, error => setRead({ state: 'refused', error: leadRefusalText(error) }))
  }
  const fallback = checkpoint.fallback || read?.state === 'shown' && read.checkpoint.fallback
  return <>
    <Marker variant="separator" data-lead-checkpoint={checkpoint.id}>
      <MarkerContent>Earlier conversation summarised</MarkerContent>
      <Button variant="link" size="inline-link" title="What the Lead keeps of the conversation before this point" onClick={view}>View</Button>
    </Marker>
    {read && <Dialog title="Earlier conversation" size="md" onClose={() => setRead(null)}
      description={fallback ? 'Put together by the desk from the conversation itself. Your later messages win.' : 'The Lead\'s summary of the conversation before this point. Your later messages win.'}
      footer={<Button onClick={() => setRead(null)}>Close</Button>}>
      {read.state === 'reading' && <Text as="p" role="muted">Reading…</Text>}
      {read.state === 'shown' && <CheckpointBody checkpoint={read.checkpoint} />}
      {read.state === 'gone' && <Text as="p" role="muted">This summary is no longer kept. The desk keeps the latest eight.</Text>}
      {read.state === 'refused' && <Text as="p" role="prose" tone="warning">{read.error}</Text>}
    </Dialog>}
  </>
}

const MODEL_SECTIONS: ReadonlySet<string> = new Set(LEAD_CHECKPOINT_SECTIONS.slice(1))
/** The model's text split at the desk's own section headings; anything else is a line of text. */
const modelParts = (text: string) => text.split('\n').reduce<{ title: string | null; lines: string[] }[]>((parts, line) => {
  const title = /^## (.+)$/.exec(line)?.[1]
  if (title && MODEL_SECTIONS.has(title)) parts.push({ title, lines: [] })
  else (parts.at(-1) ?? (parts.push({ title: null, lines: [] }), parts[0]!)).lines.push(line)
  return parts
}, [])
/** The model's words as plain text, a line a paragraph: never markup, so nothing it wrote can draw a heading, a list
 * or a quote of the person. The desk sends `<` and `>` as entities; they read as themselves here. */
const PlainLines = ({ lines }: { readonly lines: readonly string[] }) => <>
  {lines.filter(line => line.trim()).map((line, index) => <Text key={index} as="p" role="prose">{sanitizeText(line).replaceAll('&lt;', '<').replaceAll('&gt;', '>')}</Text>)}
</>
/** The person's own words, drawn from the data the desk took from its journal, never from the summary's text. */
const PersonWords = ({ person }: { readonly person: LeadCheckpointPerson }) => <Section title={LEAD_CHECKPOINT_SECTIONS[0]} data-checkpoint-person="">
  {person.messages.length
    ? <Rows>{person.messages.map(message => <Row key={message.id} title={sanitizeText(message.text)} control={<Chip tone="neutral">{message.id}</Chip>} />)}</Rows>
    : <Text as="p" role="muted">None in this part of the conversation.</Text>}
  {person.leftOut.length > 0 && <Text as="p" role="muted">{`Earlier messages left out: ${person.leftOut.join(', ')}`}</Text>}
</Section>
/** A summary as the desk keeps it: the person's words from data, then the model's sections as plain text. */
const CheckpointBody = ({ checkpoint }: { readonly checkpoint: LeadContextCheckpoint }) => <>
  {checkpoint.person && <PersonWords person={checkpoint.person} />}
  {modelParts(checkpoint.text ?? '').map((part, index) => part.title
    ? <Section key={index} title={part.title} data-checkpoint-model=""><PlainLines lines={part.lines} /></Section>
    : <PlainLines key={index} lines={part.lines} />)}
</>

const thousands = (tokens: number) => tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
const percent = (share: number) => `${Math.round(share * 100)}%`
/** The words Settings shows for the conversation's facts. */
export const leadContextWords = (facts: LeadContextFacts, now = Date.now()) => ({
  used: facts.usedTokens === null ? 'Nothing sent yet' : `${percent(facts.usedTokens / facts.windowTokens)} of ${thousands(facts.windowTokens)} tokens`,
  cache: facts.cacheHitRate === null ? 'No requests yet' : `${percent(facts.cacheHitRate)} of the prompt read from the cache`,
  // When the last summary was made is the fact that varies, as the phone shows it beside the count.
  // Every summary the thread marks; the list keeps only the latest eight.
  summaries: facts.compacting ? 'Summarising now' : facts.checkpoints.length === 0 ? 'None yet'
    : `${Math.max(facts.count ?? 0, facts.checkpoints.length)} · last ${formatAge(facts.checkpoints.at(-1)!.at, now)}`,
})

/** Settings › Lead: how full the conversation is and how much the provider served from its cache. Facts, read when shown. */
export const LeadContextSection = () => {
  const store = useStore(), active = useDestinationActive()
  const [facts, setFacts] = useState<LeadContextFacts | null>(null), [error, setError] = useState<string | null>(null), [pending, setPending] = useState(false)
  // Facts only: a desk that cannot answer, or answers something else, leaves the section out rather than a warning.
  useEffect(() => { if (active) void store.lead.readContext().then(parseLeadContextFacts).then(setFacts, () => setFacts(null)) }, [active, store])
  const compact = async () => {
    setPending(true); setError(null)
    try { setFacts(parseLeadContextFacts(await store.lead.compactContext())) } catch (failure) { setError(leadRefusalText(failure)) } finally { setPending(false) }
  }
  if (!facts && !error) return null
  const words = facts ? leadContextWords(facts) : null
  return <Section title="Conversation">
    {error && <Banner role="alert" tone="warning">{error}</Banner>}
    {facts?.full && <Banner tone="warning">The latest messages alone fill most of the Lead's room. Summaries pause until the conversation grows.</Banner>}
    {words && <Rows>
      <Row title="Context in use" desc={words.used} />
      <Row title="Cache hit rate" desc={words.cache} />
      <Row title="Summaries" desc={words.summaries} control={<Button variant="outline" disabled={pending || facts!.compacting} aria-busy={pending}
        title="Replaces the earlier conversation with a summary, so the Lead has room again." onClick={() => void compact()}>Summarise now</Button>} />
    </Rows>}
  </Section>
}

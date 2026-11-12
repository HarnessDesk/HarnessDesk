import { useEffect, useState } from 'react'
import { LEAD_RULE_LIMITS, type LeadRuleSectionView, type LeadRulesUpdate, type LeadRulesView } from '@harnessdesk/protocol'
import { Banner, Button, Chip, CodeText, Dialog, FormStack, Row, Rows, Section, Text, Textarea } from '../design'
import { useDestinationActive } from '../panels/destination-page'
import { useStore } from '../state/context'
import { leadRefusalText } from './lead-refusals'
import { leadRuleDiff } from './lead-rules-diff'
import { useLeadCalled } from './use-lead-name'

const when = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const HOW = { edit: 'Edited', reset: 'Reset to default', rollback: 'Restored' } as const

const RuleDialog = ({ section, prompt, save, close }: {
  readonly section: LeadRuleSectionView; readonly prompt: string
  readonly save: (update: LeadRulesUpdate) => Promise<void>; readonly close: () => void
}) => {
  const called = useLeadCalled()
  const [text, setText] = useState(section.text), [busy, setBusy] = useState(false), [full, setFull] = useState(false)
  useEffect(() => setText(section.text), [section.text])
  const run = async (update: LeadRulesUpdate) => { setBusy(true); try { await save(update) } finally { setBusy(false) } }
  const expectedVersion = section.version
  return <Dialog title={section.title} size="lg" onClose={close}
    footer={<>
      <Button variant="default" disabled={busy || !text.trim() || text === section.text} onClick={() => void run({ section: section.id, action: 'edit', text, expectedVersion })}>Save</Button>
      <Button variant="secondary" disabled={busy || !section.custom} onClick={() => void run({ section: section.id, action: 'reset', expectedVersion })}>Reset to default</Button>
      <Button variant="secondary" disabled={busy} onClick={close}>Close</Button>
    </>}>
    <FormStack>
      {section.defaultUpdated && <Banner tone="info" actions={<>
        <Button variant="secondary" disabled={busy} onClick={() => void run({ section: section.id, action: 'keep', expectedVersion })}>Keep mine</Button>
        <Button variant="secondary" disabled={busy} onClick={() => void run({ section: section.id, action: 'reset', expectedVersion })}>Use new</Button></>}>
        <Text role="muted">Default updated. What changed since you wrote yours:</Text>
        <CodeText as="pre" aria-label="What changed in the default">{leadRuleDiff(section.defaultUpdated.from, section.defaultUpdated.to)}</CodeText>
      </Banner>}
      <Textarea aria-label={section.title} value={text} maxLength={LEAD_RULE_LIMITS.chars} rows={8} onChange={event => setText(event.target.value)} />
      <Text role="meta">{`Takes effect at ${called}'s next epoch, never in the middle of a turn. It cannot widen what ${called} is allowed to do.`}</Text>
      <Button variant="link" onClick={() => setFull(open => !open)}>{full ? 'Hide full prompt' : 'View full prompt'}</Button>
      {full && <CodeText as="pre">{prompt || `Nothing edited. ${called[0]!.toUpperCase()}${called.slice(1)} uses the shipped words.`}</CodeText>}
      {section.history.length > 0 && <Rows aria-label={`Versions of ${section.title}`}>
        {section.history.map(entry => <Row key={entry.version} title={`Version ${entry.version}`} desc={entry.how === 'rollback' && entry.from ? `Restored from version ${entry.from}` : entry.proposal ? `Applied from ${called}'s proposal` : HOW[entry.how]}
          control={<><Text role="meta">{when(entry.at)}</Text>{entry.version !== section.version && <Button variant="secondary" disabled={busy}
            onClick={() => void run({ section: section.id, action: 'rollback', to: entry.version, expectedVersion })}>Restore</Button>}</>} />)}
        {/* The words before the first change are a version too: restoring them saves a new version, as Reset does (#2152). */}
        {section.custom && <Row title="Shipped words" tooltip={section.default.text}
          control={<Button variant="secondary" disabled={busy} onClick={() => void run({ section: section.id, action: 'reset', expectedVersion })}>Restore</Button>} />}
      </Rows>}
    </FormStack>
  </Dialog>
}

/** Settings › Lead › Rules: three sections of the person's own words, versioned, entering the model at its next epoch. */
export const LeadRulesSection = () => {
  const store = useStore(), active = useDestinationActive()
  const [view, setView] = useState<LeadRulesView | null>(null), [open, setOpen] = useState<string | null>(null), [error, setError] = useState<string | null>(null)
  useEffect(() => { if (active) void store.lead.readRules().then(next => setView(Array.isArray(next?.sections) ? next : null), failure => setError(leadRefusalText(failure))) }, [active, store])
  const save = async (update: LeadRulesUpdate) => {
    setError(null)
    try { const next = await store.lead.updateRules(update); if (Array.isArray(next?.sections)) setView(next) } catch (failure) { setError(leadRefusalText(failure)); void store.lead.readRules().then(next => { if (Array.isArray(next?.sections)) setView(next) }, () => {}) }
  }
  if (!view) return error ? <Section title="Rules"><Text role="muted">{error}</Text></Section> : null
  const section = view.sections.find(one => one.id === open)
  return <Section title="Rules">
    <Rows>
      {view.sections.map(one => <Row key={one.id} title={one.title} data-lead-settings-focus={`rules:${one.id}`} tabIndex={-1}
        titleChip={one.defaultUpdated ? <Chip tone="warning">Default updated</Chip> : one.custom ? <Chip tone="neutral">Edited</Chip> : undefined}
        control={<>{one.history[0] && <Text role="meta">{`Version ${one.version} · ${when(one.history[0].at)}`}</Text>}
          <Button variant="secondary" onClick={() => setOpen(one.id)}>Edit</Button></>} />)}
    </Rows>
    {error && <Text role="muted">{error}</Text>}
    {section && <RuleDialog section={section} prompt={view.prompt} save={save} close={() => setOpen(null)} />}
  </Section>
}

import { useState } from 'react'
import { LEAD_AUTONOMY_LABELS, LEAD_RULE_TITLES, type LeadAutonomyMode, type LeadSettingsProposal } from '@harnessdesk/protocol'
import { Button, Chip, CodeText, InlineParts, Row, Rows, Text } from '../design'
import { useStore } from '../state/context'
import { leadRefusalText } from './lead-refusals'

const MODE: Record<LeadAutonomyMode, string> = { off: 'Off', observe: 'Observe', act: 'Act' }

/** When an applied change holds, said on the card because a mode and a rule section take effect differently. */
export const LEAD_SETTINGS_EFFECT = {
  autonomy: 'Takes effect at once, for what the Lead does without being asked.',
  rules: "Takes effect at the Lead's next epoch, never in the middle of a turn.",
} as const

/** What one proposal changes, in the words Settings uses for the same row. */
export const leadSettingsProposalTitle = (proposal: LeadSettingsProposal): string => {
  const change = proposal.change
  if (change.kind === 'autonomy') return `${LEAD_AUTONOMY_LABELS[change.autonomy].title}: ${MODE[change.from]} → ${MODE[change.to]}`
  return change.add ?? `New words for ${LEAD_RULE_TITLES[change.section]}`
}

/**
 * The Lead's proposals to change a mode or a rule section, under the reply that made them. Nothing is changed until
 * the person presses Apply, which makes exactly the change shown, through the same store Settings writes; No closes the
 * card and the Lead is told. The phone draws the same card from `autonomy.proposals`.
 */
export const LeadSettingsProposals = ({ proposals }: { readonly proposals: readonly LeadSettingsProposal[] }) => {
  const store = useStore()
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null)
  const decide = (id: string, decision: 'apply' | 'decline') => {
    setPending(true); setError(null)
    void store.lead.decideSettings({ id, decision }).catch(failure => setError(leadRefusalText(failure))).finally(() => setPending(false))
  }
  return <div data-slot="lead-settings-proposals">
    <Rows aria-label="Change a setting?">{proposals.map(proposal => {
      const change = proposal.change
      return <Row key={proposal.id} title={leadSettingsProposalTitle(proposal)} desc={LEAD_SETTINGS_EFFECT[change.kind]}
        titleChip={<InlineParts>
          <Chip variant="quiet" tone="neutral">{change.kind === 'autonomy' ? 'Autonomy' : LEAD_RULE_TITLES[change.section]}</Chip>
          {proposal.askedAgainAt !== undefined && <Chip variant="quiet" tone="neutral" title="Proposed again while it waited for you; still one card">Asked again</Chip>}
        </InlineParts>}
        control={<InlineParts>
          <Button variant="outline" disabled={pending} title="Make this change, as Settings would" onClick={() => decide(proposal.id, 'apply')}>Apply</Button>
          <Button variant="quiet" disabled={pending} title="Leave the setting as it is" onClick={() => decide(proposal.id, 'decline')}>No</Button>
        </InlineParts>} />
    })}</Rows>
    {proposals.map(proposal => proposal.change.kind === 'rules' && proposal.change.add === undefined
      ? <CodeText key={proposal.id} as="pre" aria-label={`Proposed words for ${LEAD_RULE_TITLES[proposal.change.section]}`}>{proposal.change.text}</CodeText> : null)}
    {error && <Text as="p" role="muted">{error}</Text>}
  </div>
}

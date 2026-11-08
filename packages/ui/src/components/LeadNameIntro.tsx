import type { LeadName } from '@harnessdesk/protocol'
import { Button, Chip, InlineParts, LeadAvatar, LeadTurn, Text } from '../design'
import { LEAD_NAME_CHOICES } from './use-lead-name'

/** A first appearance offers a name in the Lead's own line. Keep writes the same setting as either name. */
export const LeadNameIntro = ({ name, chosen, pending, onChoose }: { readonly name: LeadName; readonly chosen: boolean; readonly pending: boolean; readonly onChoose: (name: LeadName) => void }) => chosen ? null : <LeadTurn face={<LeadAvatar name={name} size="turn" />}>
  <InlineParts><Text role="subject">{LEAD_NAME_CHOICES.find(choice => choice.name === name)!.label}</Text>
    <Chip tone="neutral"><InlineParts>
      {LEAD_NAME_CHOICES.map(choice => <Button key={choice.name} variant="link" size="inline-link" disabled={pending} onClick={() => onChoose(choice.name)}>{choice.label}</Button>)}
      <Button variant="link" size="inline-link" disabled={pending} onClick={() => onChoose(name)}>Keep</Button>
    </InlineParts></Chip>
  </InlineParts>
</LeadTurn>

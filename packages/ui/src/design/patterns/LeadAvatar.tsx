import type { LeadName } from '@harnessdesk/protocol'
import { leadFaceSrc, type LeadMood } from '../../lib/lead-faces'
import { Button } from '../ui/button'
import { RadioGroup, RadioGroupItem } from '../ui/radio-group'
import { Text } from './Settings'
import styles from './LeadAvatar.module.css'

/** Where the face is drawn; each place has one size, and only the two large ones show a mood. */
export type LeadAvatarSize = 'navigation' | 'turn' | 'header' | 'popover' | 'picker'
const LARGE: ReadonlySet<LeadAvatarSize> = new Set(['popover', 'picker'])

/**
 * The Lead's face on its character's disc. Below 28px an expression does not
 * read, so the small places draw the neutral face and the presence word beside
 * it says the state; the popover and the picker draw the mood. Never animated.
 */
export const LeadAvatar = ({ name, size = 'header', mood = 'neutral' }: { readonly name: LeadName | null; readonly size?: LeadAvatarSize; readonly mood?: LeadMood }) => {
  const src = name ? leadFaceSrc(name, mood, LARGE.has(size)) : null
  return <span role="img" aria-label={name === 'lex' ? 'Lex' : name === 'dex' ? 'Dex' : 'Lead'} data-slot="lead-avatar" data-lead={name ?? undefined} data-size={size} data-mood={LARGE.has(size) ? mood : 'neutral'} className={styles.avatar}>
    {src ? <img src={src} alt="" draggable={false} /> : <Text role="subject">…</Text>}
  </span>
}

const CHOICES: readonly { readonly value: LeadName; readonly label: string }[] = [{ value: 'dex', label: 'Dex' }, { value: 'lex', label: 'Lex' }]

/** Who runs the desk: two picture cards. A name is an immediate preference; this control never grants authority. */
export const LeadNameChoice = ({ value, pending, onChange }: { readonly value: LeadName; readonly pending: boolean; readonly onChange: (name: LeadName) => void }) =>
  <RadioGroup variant="choice" render={<span />} className={styles.choices} aria-label="Lead identity" value={value} onValueChange={next => { if (!pending && next !== value) onChange(next as LeadName) }}>
    {CHOICES.map(choice => <RadioGroupItem key={choice.value} variant="choice" value={choice.value} nativeButton disabled={pending} aria-label={choice.label}
      render={<Button type="button" variant="outline" size="inline" className={styles.choice} data-on={value === choice.value ? '' : undefined} />}>
      <LeadAvatar name={choice.value} size="picker" mood={value === choice.value ? 'working' : 'neutral'} />
      <Text role="subject">{choice.label}</Text>
    </RadioGroupItem>)}
  </RadioGroup>

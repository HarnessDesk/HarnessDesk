import type { LeadName } from '@harnessdesk/protocol'
import { IconTile } from '../ui/icon-tile'
import { Segmented, Text } from './Settings'

/** The Lead's single artwork slot; until artwork arrives it holds the chosen initial. */
export const LeadAvatar = ({ name, size = 'default' }: { readonly name: LeadName; readonly size?: 'navigation' | 'default' | 'lg' }) => <IconTile size={size} shape="round" tone="neutral" aria-label={name === 'lex' ? 'Lex' : 'Dex'}><Text role="subject">{name === 'lex' ? 'L' : 'D'}</Text></IconTile>

/** A name is an immediate preference; this control never grants authority. */
export const LeadNameChoice = ({ value, pending, onChange }: { readonly value: LeadName; readonly pending: boolean; readonly onChange: (name: LeadName) => void }) => <Segmented label="Name" value={value} options={[{ value: 'dex', label: 'Dex', disabled: pending }, { value: 'lex', label: 'Lex', disabled: pending }]} onChange={onChange} />

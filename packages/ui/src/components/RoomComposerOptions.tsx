import type { ConfigOption } from '@harnessdesk/protocol'
import { Menu, MenuLabel, MenuNote, Popover, Text } from '../design'
import { optionsBySlot, type ComposerOptionSlot } from '../lib/composer-slots'
import { selectedChoice, riskTone } from '../lib/options'
import { PaneProvider, usePane, useSnapshot } from '../state/context'
import { ComposerTrack, ModelControl, ModeControl, MoreControl, PermissionControl } from './ComposerControls'
import { ModelIcon, ShieldIcon, SlidersIcon, ZapIcon } from './Icons'
import type { RoomMember } from './RoomComposer'

const SLOTS = ['permissions', 'mode', 'more', 'model'] as const
const LABELS = { permissions: 'Permissions', mode: 'Mode', more: 'More', model: 'Model and reasoning' }
const CONTROLS = { permissions: PermissionControl, mode: ModeControl, more: MoreControl, model: ModelControl }
const ICONS = { permissions: ShieldIcon, mode: ZapIcon, more: SlidersIcon, model: ModelIcon }
const valueOf = (option: ConfigOption): string => option.type === 'select'
  ? selectedChoice(option)?.label ?? option.currentValue
  : `${option.label}: ${option.currentValue ? 'On' : 'Off'}`

/** The same fixed composer slots, whose menus let each addressed member keep
 * its own declared choices and permission confirmations. */
export const RoomComposerOptions = ({ members }: { members: readonly RoomMember[] }) => {
  const snapshot = useSnapshot()
  const pane = usePane()
  const targets = members.map((member) => {
    const session = snapshot.sessions.get(member.key)
    return { member, session, slots: optionsBySlot(session?.options) }
  })
  const summary = (slot: ComposerOptionSlot): string => {
    const values = targets.map((target) => target.slots[slot].map(valueOf).join(' · '))
    const settings = targets.map((target) => JSON.stringify(target.slots[slot].map((option) => [option.category ?? option.id, option.currentValue, valueOf(option)])))
    if (new Set(settings).size > 1) return 'Mixed'
    if (slot === 'more' || !values[0]) return LABELS[slot]
    if (slot === 'permissions' || slot === 'mode') {
      const first = targets[0]?.slots[slot][0]
      return first ? valueOf(first) : LABELS[slot]
    }
    return values[0]
  }
  return (
    <>
      {SLOTS.map((slot) => {
        const Icon = ICONS[slot]
        const Control = CONTROLS[slot]
        return (
          <ComposerTrack key={slot} name={slot}>
            <Popover
              fullWidth title={LABELS[slot]} drop="up" align="left"
              tone={slot === 'permissions' ? riskTone(targets.flatMap((target) => target.slots.permissions)) : 'calm'}
              label={<><Icon size={13} /><Text role="row" className="truncate">{summary(slot)}</Text></>}
            >
              {close => (
                <Menu close={close}>
                  {targets.length === 0 && <MenuNote>Choose a member to read its settings.</MenuNote>}
                  {targets.map(({ member, session, slots }) => {
                    const refusal = member.unavailable
                      ?? (!member.peer.here ? 'This member is stopped. Restart it to change its settings.'
                        : !session ? 'This member\'s settings are not loaded yet.' : null)
                    return (
                      <div key={member.key} data-option-target={member.key}>
                        <MenuLabel>{member.peer.nickname} <Text ink="muted">{slots[slot].map(valueOf).join(' · ')}</Text></MenuLabel>
                        {refusal ? <MenuNote>{refusal}</MenuNote>
                          : slots[slot].length === 0 ? <MenuNote>This member has no {slot === 'more' ? 'additional' : slot} setting.</MenuNote>
                            : (
                              <PaneProvider scope={{
                                paneId: `${pane?.paneId ?? 'room'}:options:${member.key}`,
                                view: { kind: 'conversation', session: member.key },
                                sessionKey: member.key,
                              }}>
                                <Control />
                              </PaneProvider>
                            )}
                      </div>
                    )
                  })}
                </Menu>
              )}
            </Popover>
          </ComposerTrack>
        )
      })}
    </>
  )
}

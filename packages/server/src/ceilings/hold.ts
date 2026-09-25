import {
  findOption,
  type AgentSession,
  type CeilingControl,
  type CeilingLevel,
  type ConfigOption,
  type OptionValue,
  type SeatCeiling,
} from '@harnessdesk/protocol'

export interface SeatHold {
  readonly ceiling: SeatCeiling
  readonly how: string | null
  readonly why: string | null
}

const said = (option: ConfigOption | undefined, value: OptionValue): string => {
  if (option?.type === 'select') return option.choices.find((choice) => choice.value === value)?.label ?? String(value)
  if (option?.type === 'boolean') return value === true ? 'on' : 'off'
  return String(value)
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Set every runtime control and call the ceiling held only after reading each value back. */
export const holdCeiling = async (
  session: Pick<AgentSession, 'options' | 'setOption'>,
  level: CeilingLevel,
  control: CeilingControl | undefined,
): Promise<SeatHold> => {
  const asked = (why: string | null): SeatHold => ({ ceiling: { level, hold: 'asked' }, how: null, why })
  if (!control) return asked(null)
  for (const setting of control.settings) {
    const option = findOption(session.options(), setting.option)
    try {
      await session.setOption(setting.option, setting.value)
    } catch (error) {
      return asked(`${option?.label ?? setting.option} could not be set to ${said(option, setting.value)}: ${messageOf(error)}`)
    }
  }
  const reported = session.options()
  for (const setting of control.settings) {
    const option = findOption(reported, setting.option)
    if (option?.currentValue !== setting.value) {
      return asked(
        option
          ? `${option.label} reads back as ${said(option, option.currentValue)}, not ${said(option, setting.value)}`
          : `${setting.option} is not a control this conversation reports any more`,
      )
    }
  }
  return { ceiling: { level, hold: 'held' }, how: control.how, why: null }
}

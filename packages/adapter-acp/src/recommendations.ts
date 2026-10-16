import { refuseOptionValue, type ConfigOption, type OptionValue } from '@harnessdesk/protocol'

/** ACP vocabulary stays here. Peers can override these fallbacks with metadata. */
export const recommendAcpOptions = (options: readonly ConfigOption[], defaultModel: string | null): readonly ConfigOption[] =>
  options.map(option => {
    let value: OptionValue | undefined = option.recommendedValue
    const offers = (candidate: string): boolean => option.type === 'select' && option.choices.some(choice => choice.value === candidate)
    if (value === undefined) {
      if (option.category === 'model') value = offers('default') ? 'default' : defaultModel ?? option.currentValue
      else if (option.category === 'thought_level') value = offers('default') ? 'default' : offers('medium') ? 'medium' : option.currentValue
      else if (option.id === 'auto_approve') value = false
      else if (option.id === 'sandbox' && offers('enabled')) value = 'enabled'
      else if (option.category === 'mode' && offers('acceptEdits')) value = 'acceptEdits'
    }
    return value !== undefined && refuseOptionValue(option, value) === null ? { ...option, recommendedValue: value } : option
  })

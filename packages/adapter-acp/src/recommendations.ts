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
    // ACP's mode that skips every permission prompt is the widest grant a chat can have: it is marked high risk, so
    // the composer colours it and work the Lead starts never inherits it.
    const marked = option.type === 'select' && option.category === 'mode' && option.choices.some(choice => choice.value === 'bypassPermissions' && choice.risk === undefined)
      ? { ...option, choices: option.choices.map(choice => choice.value === 'bypassPermissions' && choice.risk === undefined ? { ...choice, risk: 'high' as const } : choice) }
      : option
    return value !== undefined && refuseOptionValue(marked, value) === null ? { ...marked, recommendedValue: value } : marked
  })

import { useState, type ReactNode } from 'react'
import type { ConfigOption, OptionValue } from '@harnessdesk/protocol'

import { ConfirmDialog } from '../design'
import { openExternal } from '../lib/desktop'
import { AlertIcon } from './Icons'

/**
 * The gate in front of a control the runtime says is a decision.
 *
 * Most settings are preferences: click, done. A few are not — Cursor's Max
 * mode widens every context window and bills the model's API rate plus 20%,
 * and its own client puts a card in front of it rather than a switch. A
 * setting like that must never come on because a pointer passed over it.
 *
 * The words are the runtime's, in `option.confirm`; the guarantee is this
 * hook's. Nothing here knows what Max mode is — an agent that declares a
 * confirmation on some control nobody has heard of gets the same card.
 *
 * Turning something *off* is never gated: stopping a bill should take one
 * click, and asking "are you sure you want to spend less?" is a dark pattern.
 */
export const useOptionConfirm = (): {
  ask: (option: ConfigOption, value: OptionValue, commit: () => void) => void
  dialog: ReactNode
} => {
  const [pending, setPending] = useState<{
    option: ConfigOption
    commit: () => void
  } | null>(null)

  const ask = (option: ConfigOption, value: OptionValue, commit: () => void): void => {
    const gated = option.confirm && (option.type !== 'boolean' || value === true)
    if (!gated) {
      commit()
      return
    }
    setPending({ option, commit })
  }

  const confirm = pending?.option.confirm
  const pricing = confirm?.learnMore
  return {
    ask,
    dialog:
      pending && confirm ? (
        <ConfirmDialog
          title={confirm.title}
          tone="default"
          icon={<AlertIcon size={16} />}
          confirmLabel={confirm.action}
          cancelLabel="Not now"
          onConfirm={() => {
            pending.commit()
            setPending(null)
          }}
          onCancel={() => setPending(null)}
        >
          <p>{confirm.body}</p>
          {pricing && (
            <p>
              <a
                href={pricing}
                onClick={(event) => {
                  event.preventDefault()
                  openExternal(pricing)
                }}
              >
                View pricing
              </a>
            </p>
          )}
        </ConfirmDialog>
      ) : null,
  }
}

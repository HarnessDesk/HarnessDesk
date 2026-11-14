import { useEffect, useRef, useState } from 'react'

import type { CarryOnChoice, CarryOnPolicy } from '@harnessdesk/protocol'

import { Row, RowChoice, Rows, Section, Switch } from '../design'
import { useDestinationActive } from '../panels/destination-page'
import { useSnapshot, useStore } from '../state/context'

/**
 * The desk's answers, in the order a person weighs them. A row's second line
 * is only where the label cannot carry a consequence (rule 9); the
 * paraphrase every row could have is on hover.
 */
export const CARRY_ON_ROWS: readonly { readonly value: CarryOnChoice; readonly title: string; readonly desc?: string; readonly tooltip: string }[] = [
  { value: 'ask', title: 'Ask me', tooltip: 'Shows a card over the conversation each time' },
  { value: 'switch', title: 'Switch to another account', tooltip: 'Carries on without asking, and says where' },
  { value: 'wait', title: 'Wait until it resets', desc: 'Stops when no reset time is known', tooltip: 'Tries once more on the same account when it resets' },
  { value: 'stop', title: 'Stop', tooltip: 'Leaves the conversation stopped, and says so' },
]

/**
 * What happens when a conversation reaches its usage limit, for every agent
 * that has not set its own rule (Settings › Agents, per agent). A machine
 * setting, written whole, like the question wait beside it; "Always do this"
 * on the card writes the same preference, so the section reads it again
 * whenever it is shown.
 */
export const CarryOnSection = () => {
  const destinationActive = useDestinationActive()
  const store = useStore()
  const policy = useSnapshot().carryOnPolicy
  const saving = useRef(false)
  const readRevision = useRef(0)
  // Each visit reads the rule again, and the controls wait for it: a choice
  // made against the rule from the last visit could write that old rule back.
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!destinationActive || saving.current) return
    const revision = ++readRevision.current
    let live = true
    setLoading(true)
    // The store drops a read that a write overtook (one from another section,
    // or "Always do this" on a card); only the newest read ends the wait.
    void store.loadCarryOnPolicy().finally(() => { if (live && revision === readRevision.current) setLoading(false) })
    return () => { live = false }
  }, [destinationActive, store])

  const write = async (next: CarryOnPolicy): Promise<void> => {
    if (loading || saving.current || (next.onLimit === policy.onLimit && next.otherAgents === policy.otherAgents)) return
    saving.current = true
    setBusy(true)
    try {
      await store.setCarryOnPolicy(next)
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  const disabled = loading || busy
  // Nothing switches under Wait or Stop, so whether a switch may change agent is moot there.
  const switching = policy.onLimit === 'ask' || policy.onLimit === 'switch'
  return (
    <Section title="When a usage limit is reached">
      <Rows role="radiogroup" aria-label="When a usage limit is reached">
        {CARRY_ON_ROWS.map((row) => (
          <RowChoice
            key={row.value}
            title={row.title}
            {...(row.desc ? { desc: row.desc } : {})}
            tooltip={row.tooltip}
            selected={policy.onLimit === row.value}
            disabled={disabled}
            onClick={() => void write({ ...policy, onLimit: row.value })}
          />
        ))}
      </Rows>
      <Rows>
        <Row
          title="Use other agents too"
          desc="Continues in a new conversation, and its recent text goes to that agent’s provider"
          tooltip="When no account of the same agent has room"
          control={
            <Switch
              aria-label="Use other agents too"
              checked={policy.otherAgents}
              disabled={disabled || !switching}
              onCheckedChange={(next) => void write({ ...policy, otherAgents: next })}
            />
          }
        />
      </Rows>
    </Section>
  )
}

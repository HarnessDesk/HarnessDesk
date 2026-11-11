import { useEffect, useState } from 'react'
import { sessionKey, type CarryOnDecisionChoice, type CarryOnIncidentView, type RuntimeId, type SessionId } from '@harnessdesk/protocol'

import { ActionError, DecisionNotice, type DecisionChoice } from '../design'
import { carryOnCanTake, carryOnName, carryOnOthersGroup, carryOnOthersLabel, carryOnResetLine, carryOnSwitchLabel, CARRY_ON_TARGET_CHIP } from '../lib/carry-on'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'

/**
 * The card over a conversation that reached its usage limit and is waiting
 * for the person: Switch now, Wait until reset or Stop, once or always.
 *
 * Only an ordinary chat's asked incident shows here — a seat's question is
 * its Team's notice and a Lead chat's is the Lead's inbox. Every name is the
 * one the host put in the incident, which it took from the runtime's
 * presentation (rule 8); nothing here asks which backend is running.
 * It fills in `DecisionNotice` and adds nothing of its own to draw.
 */
export const CarryOnNotice = ({ runtime, sessionId }: { runtime: RuntimeId; sessionId: SessionId }) => {
  const incident = useSnapshot().carryOnIncidents.get(sessionKey(runtime, sessionId))
  return incident && incident.owner === 'chat' && incident.state === 'asked' ? <CarryOnCard key={incident.incidentId} incident={incident} /> : null
}

const CarryOnCard = ({ incident }: { incident: CarryOnIncidentView }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setError(null), [incident.state])

  const decide = async (choice: CarryOnDecisionChoice, always: boolean, target?: RuntimeId): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await store.decideCarryOn({ incidentId: incident.incidentId, choice, always, ...(target ? { target } : {}) })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const target = incident.choices.target
  const choices: DecisionChoice[] = [
    target
      ? { id: 'switch', label: carryOnSwitchLabel(target), primary: true }
      : { id: 'switch', label: 'Switch now', disabled: true, hint: 'No other account or agent has room' },
    incident.choices.wait
      ? { id: 'wait', label: 'Wait until reset', ...(target ? {} : { primary: true }) }
      : { id: 'wait', label: 'Wait until reset', disabled: true, hint: 'No reset time' },
    { id: 'stop', label: 'Stop' },
  ]
  // Only somewhere the work could go now: a signed-out account or one with
  // no room would only be refused, so neither is offered.
  const others = incident.others.filter(carryOnCanTake)
  const info = snapshot.runtimes.find(entry => entry.id === incident.runtime)
  const detail = [carryOnResetLine(incident), incident.note].filter(Boolean).join(' · ')
  return (
    <DecisionNotice
      message={`${carryOnName(incident.from)} reached its usage limit.`}
      detail={detail}
      {...(info ? { mark: <RuntimeMark runtime={info} size={14} /> } : {})}
      choices={choices}
      always={{ label: incident.alwaysScope === 'agent' ? `Always do this for ${incident.from.name}` : 'Always do this' }}
      alternatives={{
        label: carryOnOthersLabel(others),
        items: others.map(other => ({
          id: other.runtime,
          name: carryOnName(other),
          group: carryOnOthersGroup(other),
          ...(other.state ? { chip: CARRY_ON_TARGET_CHIP[other.state] } : {}),
        })),
        onPick: (id, always) => void decide('switch', always, id as RuntimeId),
      }}
      busy={busy}
      // "Switch to B" means B: the target goes with the answer, so the host
      // refuses it if B is no longer a candidate rather than pick another.
      onChoose={(id, always) => void decide(id as CarryOnDecisionChoice, always, id === 'switch' ? target?.runtime : undefined)}
    >
      {error ? <ActionError>{error}</ActionError> : null}
    </DecisionNotice>
  )
}

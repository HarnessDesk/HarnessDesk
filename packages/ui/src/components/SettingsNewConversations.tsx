import { useEffect, useState } from 'react'
import { runtimeId, type ConfigOption, type OptionValue } from '@harnessdesk/protocol'
import { Banner, PageOptions, Row, Rows, RowValue, SectionHead } from '../design'
import { useSnapshot, useStore } from '../state/context'
import { explainedBySignIn } from '../lib/sign-in-refusal'

const RECOMMENDED = '\u0000recommended'

/** General and the composer use the same per-runtime picks. */
export default function SettingsNewConversations() {
  const store = useStore()
  const snapshot = useSnapshot()
  const runtime = snapshot.activeRuntime
  const [options, setOptions] = useState<readonly ConfigOption[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    setOptions([])
    setError(null)
    if (runtime) void Promise.resolve(store.newSessionDefaultsFor(runtime)).then(answer => {
      if (current) setOptions(answer ?? [])
    }).catch(async error => {
      if (!current) return
      setError(error instanceof Error ? error.message : 'The runtime could not read its new-conversation defaults. Try again.')
      const choices = await store.newSessionDefaultChoicesFor(runtime).catch(() => [])
      if (current) setOptions(choices)
    })
    return () => { current = false }
  }, [store, runtime])
  const permission = options.find(option => option.category === '_permissions')
    ?? options.find(option => option.category === 'mode' && option.recommendedValue !== undefined)
  const model = options.find(option => option.category === 'model')
  const effort = options.find(option => option.category === 'thought_level')
  const control = (option: ConfigOption, label: string) => <PageOptions choices={[{
    id: option.id, label, mode: 'menu',
    value: Object.hasOwn(snapshot.draftValues, option.id) ? String(snapshot.draftValues[option.id]) : RECOMMENDED,
    items: [
      { value: RECOMMENDED, label: 'Recommended', title: option.type === 'select'
        ? option.choices.find(choice => choice.value === option.recommendedValue)?.label : undefined },
      ...(option.type === 'select' ? option.choices.map(choice => ({ ...choice, title: choice.description, disabled: option.disabled ?? choice.disabled }))
        : [{ value: 'false', label: 'Ask before acting' }, { value: 'true', label: 'Approve automatically' }]),
    ],
    change: value => {
      if (!runtime) return
      const next = value === RECOMMENDED ? store.clearNewSessionDefault(runtime, option.id)
        : store.setNewSessionDefault(runtime, option.id, option.type === 'boolean' ? value === 'true' : value as OptionValue)
      void next.then(async answer => {
        if (store.getSnapshot().activeRuntime !== runtime) return
        setOptions(answer)
        // A refused recommendation stays visible until an explicit pick
        // makes the complete set of start values acceptable.
        if (error) await store.newSessionDefaultsFor(runtime)
        if (store.getSnapshot().activeRuntime === runtime) setError(null)
      }).catch(failure => {
        if (store.getSnapshot().activeRuntime === runtime) setError(failure instanceof Error
          ? failure.message : 'The runtime could not read its new-conversation defaults. Try again.')
      })
    },
  }]} />
  // A signed-out default's refusal is what its banner already says (#1775).
  const shown = error !== null && runtime && explainedBySignIn(error, snapshot.accountsByRuntime[runtime]) ? null : error
  return <>
    <SectionHead level="label" name="New conversations" />
    {shown && <Banner tone="warning">{shown}</Banner>}
    <Rows>
      <Row title="Default runtime" control={snapshot.runtimes.length === 0 ? <RowValue>No runtime added</RowValue> : <PageOptions choices={[{
        id: 'runtime', label: 'Default runtime', mode: 'menu', value: runtime ?? '',
        items: snapshot.runtimes.map(info => ({ value: info.id, label: info.presentation.name })),
        change: value => { void store.selectRuntime(runtimeId(value)) },
      }]} />} />
      {permission && <Row title="Default permission level" control={control(permission, 'Default permission level')} />}
      {model && <Row title="Default model" control={control(model, 'Default model')} />}
      {effort && <Row title="Default reasoning effort" control={control(effort, 'Default reasoning effort')} />}
    </Rows>
  </>
}

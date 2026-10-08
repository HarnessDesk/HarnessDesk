import { useEffect, useState } from 'react'
import { runtimeId, sessionId, sessionKey, type ConfigOption, type RuntimeInfo, type Session } from '@harnessdesk/protocol'
import { AgentControl, ComposerTrack, ModeControl, ModelControl, MoreControl, PermissionControl } from '../components/ComposerControls'
import { ContextUsage } from '../components/ContextUsage'
import { NewSessionDefaults } from '../components/SettingsAgents'
import { Button, ComposerGap, ComposerSend, ComposerTools, Text } from '../design'
import type { TransportEvents } from '../lib/transport'
import { PaneProvider, StoreProvider } from '../state/context'
import { AppStore } from '../state/store'

const runtime = { id: runtimeId('preview-staleness'), name: 'Assistant', capabilities: {}, presentation: { name: 'Assistant' } } as unknown as RuntimeInfo
const id = sessionId('preview-live')
const key = sessionKey(runtime.id, id)
const initial: ConfigOption[] = [{ id: 'model', label: 'Model', category: 'model', type: 'select', currentValue: 'model-a', choices: [
  { value: 'model-a', label: 'Model A' }, { value: 'model-b', label: 'Model B' },
] }, { id: 'effort', label: 'Reasoning', category: 'thought_level', type: 'select', currentValue: 'low', choices: [{ value: 'low', label: 'Low' }] }]
const replaced: ConfigOption[] = [
  { ...initial[0]!, choices: [{ value: 'model-b', label: 'Model B' }] } as ConfigOption,
  initial[1]!,
  { id: 'mode', label: 'Mode', category: 'mode', type: 'select', currentValue: 'plan', choices: [{ value: 'plan', label: 'Plan' }, { value: 'direct', label: 'Direct' }] },
]

/** An in-memory peer driving the production store, reducer, controls and Settings row. */
const fixture = () => {
  const store = new AppStore('ws://127.0.0.1:0/')
  let options = initial
  let setters = 0
  let sends = 0
  let preferences: Record<string, unknown> = {}
  const session: Session = { runtime: runtime.id, id, cwd: '/workspace', status: { type: 'idle' }, createdAt: 0, updatedAt: 0, turns: [], itemsLoaded: true, options }
  store.transport.request = (async (method: string, params: { patch?: Record<string, unknown>; optionId?: string; value?: string }) => {
    if (method === 'runtime/sessionDefaults') return options
    if (method === 'app/state/get') return preferences
    if (method === 'app/state/set') { preferences = { ...preferences, ...params.patch }; return {} }
    if (method === 'session/read' || method === 'session/resume') return session
    if (method === 'session/options/set') {
      setters += 1
      options = options.map((one) => one.id === params.optionId ? { ...one, currentValue: params.value } as ConfigOption : one)
      handlers.onEvent(runtime.id, { type: 'session/options', sessionId: id, options })
    }
    if (method === 'turn/send') sends += 1
    if (method === 'runtime/health') return { state: 'stopped' }
    if (method === 'runtime/account') return null
    return []
  }) as never
  const handlers = (store.transport as unknown as { handlers: TransportEvents }).handlers
  handlers.onStatus('open')
  handlers.onNotification({ method: 'sync', params: { runtimes: [runtime], sessions: [] } as never })
  return { store, async start() { await store.setNewSessionDefault(runtime.id, 'model', 'model-a'); await store.openSession(id, { runtime: runtime.id }) },
    replace() { options = replaced; handlers.onEvent(runtime.id, { type: 'session/options', sessionId: id, options }) },
    counts: () => ({ setters, sends }) }
}

export const ComposerStalenessContent = () => {
  const [rig] = useState(fixture)
  const [ready, setReady] = useState(false)
  const [counts, setCounts] = useState({ setters: 0, sends: 0 })
  useEffect(() => { void rig.start().then(() => setReady(true)); return rig.store.subscribe(() => setCounts(rig.counts())) }, [rig])
  if (!ready) return null
  return <section data-composer-staleness className="grid gap-4 p-4">
    <Text as="h3" role="section">Live configuration and saved defaults</Text>
    <Button variant="outline" size="sm" data-replace-options onClick={() => { rig.replace(); setCounts(rig.counts()) }}>Replace configuration</Button>
    <StoreProvider store={rig.store}>
      <PaneProvider scope={{ paneId: 'preview-staleness' as never, view: { kind: 'conversation', session: key }, sessionKey: key }}>
        <ComposerTools data-composer-layout="live">
          <ComposerTrack name="add"><Button variant="ghost" size="sm" aria-label="Add">+</Button></ComposerTrack>
          <AgentControl /><PermissionControl /><ModeControl /><ComposerTrack name="extension" /><ComposerGap />
          <MoreControl /><ContextUsage /><ModelControl />
          <ComposerTrack name="send"><ComposerSend aria-label="Send" onClick={() => { void rig.store.send([{ type: 'text', text: 'A placeholder prompt.' }], key).then(() => setCounts(rig.counts())) }}>↑</ComposerSend></ComposerTrack>
        </ComposerTools>
      </PaneProvider>
      <NewSessionDefaults info={runtime} />
    </StoreProvider>
    <Text role="muted" data-setter-count>Selection changes: {counts.setters}</Text>
    <Text role="muted" data-send-count>Messages sent: {counts.sends}</Text>
  </section>
}

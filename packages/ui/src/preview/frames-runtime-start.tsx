import { NO_CAPABILITIES, runtimeId, type AuthMethod, type ConfigOption, type RuntimeInfo } from '@harnessdesk/protocol'
import { Composer } from '../components/Composer'
import { RuntimesSection } from '../components/SettingsAgents'
import { StoreProvider } from '../state/context'
import { useMemo } from 'react'
import { Frame } from './main'
import { previewStore } from './harness'

/** Synthetic launch states: the default is ready; the other agent waits for intent. */
export const RuntimeStartFrames = () => {
  const state = new URLSearchParams(window.location.search).get('runtime-start') ?? 'cold'
  const controls = new URLSearchParams(window.location.search).get('controls')
  const signInFlows = new URLSearchParams(window.location.search).get('signin-flows')
  const store = useMemo(() => {
    const runtimes: RuntimeInfo[] = ['Alpha', 'Beta'].map(name => ({
      id: runtimeId(name.toLowerCase()), name, version: name === 'Beta' && state === 'cold' ? null : '1.0.0',
      capabilities: { ...NO_CAPABILITIES, account: true }, presentation: { name },
    }))
    const store = previewStore({
      status: 'open', runtimes, activeRuntime: runtimeId('alpha'), activeSessionKey: null, sessions: new Map(),
      health: { state: 'ready' }, draftOptions: null,
      healthByRuntime: { alpha: { state: 'ready' }, beta: { state: state === 'before' ? 'ready' : 'idle' } },
      accountsByRuntime: {
        [runtimeId('alpha')]: { accounts: [{ kind: 'subscription', label: 'Jane Doe', planType: 'Demo' }], signInMethods: [] },
        ...(state === 'cold' ? {} : { [runtimeId('beta')]: { accounts: [{ kind: 'subscription', label: 'Jane Doe', planType: 'Demo' }], signInMethods: [] } }),
      },
    })
    if (controls === 'signin') {
      const patch = (store as unknown as { patch: (values: Partial<ReturnType<typeof store.getSnapshot>>) => void }).patch
      const methods: readonly AuthMethod[] = signInFlows === null
        ? [{ id: 'cli-browser', label: 'Sign in in your browser', flow: 'browser' }]
        : [
          { id: 'cli-browser', label: 'Sign in in your browser', flow: 'browser' },
          { id: 'cli-code', label: 'Sign in with a code', flow: 'deviceCode' },
          { id: 'cli-key', label: 'Use an API key', flow: 'external' },
        ].filter(method => signInFlows.split(',').includes(method.flow)) as AuthMethod[]
      patch({ accountsByRuntime: { ...store.getSnapshot().accountsByRuntime, [runtimeId('beta')]: { accounts: [], signInMethods: state === 'signin-before' ? [] : methods } } })
    }
    if (controls) {
      store.runtimeResources = async () => []
      const declarations: readonly ConfigOption[] = [
        { type: 'select', id: 'model', label: 'Model', category: 'model', currentValue: 'small', choices: [{ value: 'small', label: 'Small' }, { value: 'large', label: 'Large' }] },
        { type: 'select', id: 'effort', label: 'Effort', category: 'thought_level', currentValue: 'high', choices: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] },
        { type: 'boolean', id: 'sandbox', label: 'Sandbox', currentValue: true },
      ]
      const patch = (store as unknown as { patch: (values: Partial<ReturnType<typeof store.getSnapshot>>) => void }).patch
      store.healthFor = async id => store.getSnapshot().healthByRuntime[id] ?? { state: 'idle' }
      store.newSessionDefaultsFor = async id => controls === 'composer' || store.getSnapshot().healthByRuntime[id]?.state === 'ready' ? declarations : []
      store.selectRuntime = async id => patch({ activeRuntime: id, health: { state: 'idle' }, draftOptions: null })
      store.loadDraftOptions = async () => patch({ draftOptions: declarations })
      store.transport.request = (async (method: string) => {
        if (method === 'runtime/warm' && controls === 'settings') {
          setTimeout(() => patch({ healthByRuntime: { ...store.getSnapshot().healthByRuntime, beta: { state: 'ready' } } }), 60)
        }
        return null
      }) as typeof store.transport.request
    }
    return store
  }, [state, controls, signInFlows])
  return <Frame id="runtime-start" title={controls === 'settings' ? 'Agent settings after warm-up' : controls === 'composer' ? 'Choosing an idle agent' : controls === 'signin' ? 'Cached signed-out agent' : 'Runtimes at launch'}><StoreProvider store={store}><div className="mx-auto max-w-[760px] px-8 py-10">{controls === 'composer' ? <Composer onChooseProject={() => {}} /> : <RuntimesSection focus={controls === 'settings' || controls === 'signin' ? 'beta' : undefined} onSignIn={() => {}} />}</div></StoreProvider></Frame>
}

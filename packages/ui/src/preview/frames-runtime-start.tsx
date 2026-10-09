import { NO_CAPABILITIES, runtimeId, type RuntimeInfo } from '@harnessdesk/protocol'
import { RuntimesSection } from '../components/SettingsAgents'
import { StoreProvider } from '../state/context'
import { useMemo } from 'react'
import { Frame } from './main'
import { previewStore } from './harness'

/** Synthetic launch states: the default is ready; the other agent waits for intent. */
export const RuntimeStartFrames = () => {
  const state = new URLSearchParams(window.location.search).get('runtime-start') ?? 'cold'
  const store = useMemo(() => {
    const runtimes: RuntimeInfo[] = ['Alpha', 'Beta'].map(name => ({
      id: runtimeId(name.toLowerCase()), name, version: name === 'Beta' && state === 'cold' ? null : '1.0.0',
      capabilities: { ...NO_CAPABILITIES, account: true }, presentation: { name },
    }))
    return previewStore({
      status: 'open', runtimes, activeRuntime: runtimeId('alpha'),
      healthByRuntime: { alpha: { state: 'ready' }, beta: { state: state === 'before' ? 'ready' : 'idle' } },
      accountsByRuntime: {
        [runtimeId('alpha')]: { accounts: [{ kind: 'subscription', label: 'Jane Doe', planType: 'Demo' }], signInMethods: [] },
        ...(state === 'cold' ? {} : { [runtimeId('beta')]: { accounts: [{ kind: 'subscription', label: 'Jane Doe', planType: 'Demo' }], signInMethods: [] } }),
      },
    })
  }, [state])
  return <Frame id="runtime-start" title="Runtimes at launch"><StoreProvider store={store}><div className="mx-auto max-w-[760px] px-8 py-10"><RuntimesSection onSignIn={() => {}} /></div></StoreProvider></Frame>
}

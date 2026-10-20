import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { StoreProvider } from '../src/state/context'
import { useTheme } from '../src/state/theme'
import { dashboardData, DashboardScene } from './dashboard'
import { isDashboardScene, SCENES, type SceneName } from './scenes'
import { PageSceneBody, usePageStore, type PageSceneName } from './pages'
import { RaceScene } from './race'
import { withRealNamesAlways } from './real-names'
import { raceStore } from '../src/preview/readme-race'
import type { AppStore } from '../src/state/store'
import './scene.css'

const SceneBody = ({ name, motion, store, children }: { name: SceneName; motion?: 'reduce'; store: AppStore; children: ReactNode }) => {
  useTheme()
  const scene = SCENES[name]
  const [reduced, setReduced] = useState(() => motion === 'reduce' || window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  // Visibility governs timers only. This scene has no playback timer; local
  // controls and scrolling remain available even before the parent is ready.
  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => window.parent.postMessage({ type: 'hdDemoReady' }, '*'))
    })
    return () => cancelAnimationFrame(frame)
  }, [])
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const change = () => setReduced(motion === 'reduce' || media.matches)
    change()
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [motion])
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const message = event.data
      if (!message || typeof message !== 'object') return
      if (message.type === 'theme' && (message.value === 'light' || message.value === 'dark')) store.setTheme(message.value)
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [store])
  return <div data-site-scene={name} data-scene-motion={reduced ? 'reduce' : 'interactive'}
    className="site-scene" style={{ width: scene.width, height: scene.height }}>
    {children}
  </div>
}

const Dashboard = ({ name, theme, motion }: { name: SceneName; theme: 'light' | 'dark'; motion?: 'reduce' }) => {
  const data = useMemo(() => { const data = dashboardData(); data.store.setTheme(theme); return data }, [])
  return <StoreProvider store={data.store}><SceneBody name={name} motion={motion} store={data.store}><DashboardScene data={data} view={name} /></SceneBody></StoreProvider>
}

const Page = ({ name, theme, motion }: { name: PageSceneName; theme: 'light' | 'dark'; motion?: 'reduce' }) => {
  const store = usePageStore(name, theme)
  const { width, height } = SCENES[name]
  return <StoreProvider store={store}><SceneBody name={name} motion={motion} store={store}><PageSceneBody store={store} width={width} height={height} /></SceneBody></StoreProvider>
}

const Race = ({ theme, motion }: { theme: 'light' | 'dark'; motion?: 'reduce' }) => {
  const store = useMemo(() => withRealNamesAlways(raceStore(theme)), [])
  return <StoreProvider store={store}><SceneBody name="hero-race" motion={motion} store={store}><RaceScene store={store} motion={motion} /></SceneBody></StoreProvider>
}

export const SiteScene = ({ name, theme = 'light', motion }: { name: SceneName; theme?: 'light' | 'dark'; motion?: 'reduce' }) =>
  name === 'hero-race' ? <Race theme={theme} motion={motion} />
    : isDashboardScene(name) ? <Dashboard name={name} theme={theme} motion={motion} /> : <Page name={name} theme={theme} motion={motion} />

import { useEffect, useMemo, useState } from 'react'
import { StoreProvider } from '../src/state/context'
import { useTheme } from '../src/state/theme'
import { dashboardData, DashboardScene } from './dashboard'
import { SCENES, type SceneName } from './scenes'
import './scene.css'

const SceneBody = ({ name, motion, data }: { name: SceneName; motion?: 'reduce'; data: ReturnType<typeof dashboardData> }) => {
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
      if (message.type === 'theme' && (message.value === 'light' || message.value === 'dark')) data.store.setTheme(message.value)
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [data])
  return <div data-site-scene={name} data-scene-motion={reduced ? 'reduce' : 'interactive'}
    className="site-scene" style={{ width: scene.width, height: scene.height }}>
    <DashboardScene data={data} view={name} />
  </div>
}

export const SiteScene = ({ name, theme = 'light', motion }: { name: SceneName; theme?: 'light' | 'dark'; motion?: 'reduce' }) => {
  const data = useMemo(() => { const data = dashboardData(); data.store.setTheme(theme); return data }, [])
  return <StoreProvider store={data.store}><SceneBody name={name} motion={motion} data={data} /></StoreProvider>
}

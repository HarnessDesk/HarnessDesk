import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { StoreProvider } from '../src/state/context'
import { useTheme } from '../src/state/theme'
import { dashboardData, DashboardScene, type DashboardStage } from './dashboard'
import { SCENES, type SceneName } from './scenes'
import './scene.css'

const STAGES: DashboardStage[] = ['limits', 'spend', 'agents', 'year']
const radio = (box: HTMLElement, name: string) => [...box.querySelectorAll<HTMLElement>('[role="radio"]')]
  .find(node => (node.textContent ?? '').trim().startsWith(name))

/** Scene-only pointer. Product controls receive the same mouse sequence as a person. */
const press = (target: HTMLElement) => {
  const rect = target.getBoundingClientRect()
  const at = { clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, bubbles: true, cancelable: true, button: 0 }
  target.dispatchEvent(new PointerEvent('pointerdown', { ...at, buttons: 1, pointerType: 'mouse', pointerId: 1, isPrimary: true }))
  target.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }))
  target.dispatchEvent(new PointerEvent('pointerup', { ...at, buttons: 0, pointerType: 'mouse', pointerId: 1, isPrimary: true }))
  target.dispatchEvent(new MouseEvent('mouseup', at))
  target.click()
  target.blur()
}

const SceneBody = ({ name, motion, data }: { name: SceneName; motion?: 'reduce'; data: ReturnType<typeof dashboardData> }) => {
  useTheme()
  const scene = SCENES[name]
  const box = useRef<HTMLDivElement>(null)
  const pointer = useRef<HTMLDivElement>(null)
  const elapsed = useRef(0)
  const [visible, setVisible] = useState(false)
  const [reduced, setReduced] = useState(() => motion === 'reduce' || window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [time, setTime] = useState(reduced ? scene.still : 0)
  const stage = STAGES[Math.floor(time / 4000)]!
  const actionKey = useRef('')
  const point = useRef({ x: scene.width / 2, y: scene.height / 2 })

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
      if (message.type === 'visible' && typeof message.value === 'boolean') setVisible(message.value)
      if (message.type === 'theme' && (message.value === 'light' || message.value === 'dark')) data.store.setTheme(message.value)
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [data])
  useEffect(() => {
    if (reduced) { elapsed.current = scene.still; setTime(scene.still); return }
    if (!visible) return
    let previous = performance.now()
    let frame = 0
    const tick = (now: number) => {
      elapsed.current = (elapsed.current + now - previous) % scene.duration
      previous = now
      setTime(elapsed.current)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [visible, reduced, scene])

  useLayoutEffect(() => {
    if (!box.current) return
    if (reduced) {
      const year = radio(box.current, 'Year')
      if (year?.getAttribute('aria-checked') === 'false') press(year)
      return
    }
    const phase = time % 4000
    const name = stage === 'limits' ? phase < 2400 ? 'Windows' : 'All'
      : stage === 'spend' ? phase < 2400 ? 'Line' : 'Bars'
        : stage === 'agents' ? 'By agent' : 'Year'
    const target = radio(box.current, name)
    if (!target) return
    const rect = target.getBoundingClientRect()
    const surface = box.current.getBoundingClientRect()
    const destination = { x: rect.x - surface.x + rect.width / 2, y: rect.y - surface.y + rect.height / 2 }
    point.current = { x: point.current.x + (destination.x - point.current.x) * 0.18, y: point.current.y + (destination.y - point.current.y) * 0.18 }
    if (pointer.current) {
      pointer.current.style.transform = `translate(${point.current.x}px, ${point.current.y}px)`
      pointer.current.style.visibility = phase < 500 ? 'hidden' : 'visible'
    }
    const key = `${stage}:${name}`
    const at = stage === 'limits' || stage === 'spend' ? phase < 2400 ? 900 : 2900 : 300
    if (phase >= at && actionKey.current !== key) { actionKey.current = key; press(target) }
  }, [time, stage, reduced])

  return <div ref={box} data-site-scene={name} data-scene-time={Math.round(time)} data-scene-motion={reduced ? 'reduce' : 'play'}
    className="site-scene" style={{ width: scene.width, height: scene.height }}>
    <DashboardScene stage={stage} data={data} />
    {!reduced && <div ref={pointer} className="site-scene-pointer" data-scene-pointer aria-hidden="true" />}
  </div>
}

export const SiteScene = ({ name, theme = 'light', motion }: { name: SceneName; theme?: 'light' | 'dark'; motion?: 'reduce' }) => {
  const data = useMemo(() => { const data = dashboardData(); data.store.setTheme(theme); return data }, [])
  return <StoreProvider store={data.store}><SceneBody name={name} motion={motion} data={data} /></StoreProvider>
}

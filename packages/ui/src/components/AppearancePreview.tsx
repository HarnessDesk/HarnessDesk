import { lazy, Suspense, useEffect, useMemo, useState } from 'react'

import { editorLook } from '../lib/editor-prefs'
import { useSnapshot, useStore } from '../state/context'
import styles from './AppearancePreview.module.css'

/**
 * The Appearance page's preview: what the choices below it do, before any
 * of them is made.
 *
 * Codex Desktop leads its Appearance page with three miniature windows and a
 * live code sample, and it is the right order — a setting whose effect is
 * visible on the page it lives on needs no sentence explaining it. The theme
 * cards are illustrations rather than renders: each one has to show its own
 * face whatever face the window is wearing, and the token layer is switched on
 * `body`, so a real render of "Light" inside a dark window is not a thing the
 * system can draw. A picture of a window is honest about being a picture.
 *
 * The code sample is not a picture. It is the app's own editor, read-only, on
 * the live tokens — so the face, the size, the line numbers and the wrap flip
 * as the rows under it are changed, which is the whole point of putting it
 * here.
 */

const CodeEditor = lazy(async () => ({ default: (await import('./CodeEditor')).CodeEditor }))

const SAMPLE = `export const plan = async (task: Task): Promise<Step[]> => {
  const steps = await agent.propose(task, { effort: 'high' })
  if (steps.length === 0) throw new Error('nothing to do')
  return steps.filter((step) => !step.done).map((step, index) => ({
    ...step,
    order: index + 1,
  }))
}
`

/** Whether the window is dark right now, following the system when asked to. */
export const useResolvedDark = (): boolean => {
  const { theme } = useSnapshot()
  const [system, setSystem] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = (event: MediaQueryListEvent): void => setSystem(event.matches)
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [])
  return theme === 'system' ? system : theme === 'dark'
}

/*
 * One miniature window. Two faces, drawn from six greys, plus the two marks
 * the rows underneath actually move: the row you are on, in the live accent,
 * and the button, in the face's own ink. `both` splits the picture down the
 * middle, which is what "System" means.
 *
 * The button is the face's ink and not `--hd-accent`, and that is the whole
 * point of the split the token layer now makes — a filled button in this app
 * is ink, so a card that drew it in the brand was advertising a colour the
 * window does not use. It has to come from `face()` rather than from
 * `--hd-solid` for the same reason every other value here does: the token is
 * switched on `body`, so the "Light" card inside a dark window would resolve
 * the solid to near-white and draw a white button on a white card.
 *
 * The accent stays live, because it can: it is the same colour in both faces,
 * and it is now on the mark that earns it — the selected row.
 */
const Mini = ({ dark, both }: { dark: boolean; both?: boolean }) => {
  const face = (isDark: boolean) =>
    isDark
      ? { page: '#1f1f22', rail: '#161618', bar: '#3a3a40', text: '#55555c', card: '#27272b', ink: '#f4f4f5' }
      : { page: '#ffffff', rail: '#f4f4f5', bar: '#e4e4e7', text: '#c9c9ce', card: '#ffffff', ink: '#18181b' }
  const draw = (isDark: boolean, clip?: string) => {
    const c = face(isDark)
    return (
      <g {...(clip ? { clipPath: `url(#${clip})` } : {})}>
        <rect x="0" y="0" width="240" height="160" fill={c.page} />
        <rect x="0" y="0" width="64" height="160" fill={c.rail} />
        <rect x="10" y="14" width="44" height="6" rx="3" fill={c.bar} />
        {/* The row you are on. The one mark in the picture that is the brand,
            which is what the Accent row below moves. */}
        <rect x="10" y="30" width="34" height="5" rx="2.5" fill="var(--hd-accent)" />
        <rect x="10" y="42" width="40" height="5" rx="2.5" fill={c.text} />
        <rect x="10" y="54" width="30" height="5" rx="2.5" fill={c.text} />
        <rect x="84" y="20" width="60" height="7" rx="3.5" fill={c.bar} />
        <rect x="84" y="40" width="136" height="44" rx="6" fill={c.card} stroke={c.bar} />
        <rect x="96" y="50" width="70" height="5" rx="2.5" fill={c.text} />
        <rect x="96" y="62" width="100" height="5" rx="2.5" fill={c.text} />
        <rect x="96" y="74" width="50" height="5" rx="2.5" fill={c.text} />
        <rect x="84" y="98" width="136" height="44" rx="6" fill={c.card} stroke={c.bar} />
        <rect x="96" y="108" width="80" height="5" rx="2.5" fill={c.text} />
        <rect x="96" y="120" width="60" height="5" rx="2.5" fill={c.text} />
        {/* The button. Ink, the way every filled button in the app is. */}
        <rect x="186" y="118" width="24" height="12" rx="4" fill={c.ink} />
      </g>
    )
  }
  return (
    <svg className={styles.mini} viewBox="0 0 240 160" aria-hidden="true">
      {both ? (
        <>
          <defs>
            <clipPath id="hd-mini-left">
              <rect x="0" y="0" width="120" height="160" />
            </clipPath>
            <clipPath id="hd-mini-right">
              <rect x="120" y="0" width="120" height="160" />
            </clipPath>
          </defs>
          {draw(false, 'hd-mini-left')}
          {draw(true, 'hd-mini-right')}
        </>
      ) : (
        draw(dark)
      )}
    </svg>
  )
}

const THEMES = [
  { value: 'system', label: 'System', both: true, dark: false },
  { value: 'light', label: 'Light', both: false, dark: false },
  { value: 'dark', label: 'Dark', both: false, dark: true },
] as const

/** The three faces, as pictures you press. */
export const ThemeCards = () => {
  const store = useStore()
  const { theme } = useSnapshot()
  return (
    <div className={styles.cards} role="radiogroup" aria-label="Theme">
      {THEMES.map((entry) => (
        <button
          key={entry.value}
          type="button"
          role="radio"
          aria-checked={theme === entry.value}
          className={styles.card}
          {...(theme === entry.value ? { 'data-on': '' } : {})}
          onClick={() => store.setTheme(entry.value)}
        >
          <Mini dark={entry.dark} both={entry.both} />
          <span className={styles.cardLabel}>{entry.label}</span>
        </button>
      ))}
    </div>
  )
}

/** The editor as it will look, on the live tokens and the live preferences. */
export const EditorSample = () => {
  const { editorPrefs } = useSnapshot()
  const dark = useResolvedDark()
  const appearance = useMemo(() => editorLook(editorPrefs), [editorPrefs])
  return (
    <div className={styles.sample} aria-label="Code editor preview">
      <Suspense fallback={<div className={styles.sampleBlank} />}>
        <CodeEditor
          className={styles.sampleEditor}
          value={SAMPLE}
          path="plan.ts"
          readOnly
          dark={dark}
          look={appearance}
          lineNumbers={editorPrefs.lineNumbers}
          wrap={editorPrefs.wrap}
          tabSize={editorPrefs.tabSize}
          ariaLabel="Code editor preview"
        />
      </Suspense>
    </div>
  )
}

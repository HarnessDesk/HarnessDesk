import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import { CanvasFitIcon, CanvasHandIcon, CanvasSelectIcon, CheckIcon, CommentIcon, CopyIcon, DownloadIcon, TrashIcon, ZoomInIcon, ZoomOutIcon } from '../components/Icons'
import { Button, Chip, FlowCanvasToolbar, GroupLabel, Segmented, Textarea } from '../design'
import { GUIDES_MODES, useGuidesMode, type GuidesMode, type GuidesReport } from '../design/explorer/guides'
import { fit, intersects, pan, visibleRect, wheelFactor, zoomAt, type Camera, type Rect } from './camera'
import { addNote, notesMarkdown, removeNote, updateNote, useNotes, type Note } from './notes'
import { SECTIONS, WINDOW, sceneUrl, type Scene } from './scenes'
import styles from './review.module.css'

/**
 * The review board: every scene of the app laid out as a real window on one
 * zoomable canvas, guides switched over all of them at once, and notes pinned
 * where a reviewer points.
 *
 * Board geometry is data, not design: a window is drawn at its true pixel
 * size and the camera scales the whole board, so a 14px label reads at 14px
 * at 100% exactly as it does in the app.
 */

type Theme = 'light' | 'dark'
type Themes = 'light' | 'dark' | 'both'
type Tool = 'hand' | 'interact' | 'comment'
type Placed = { key: string; scene: Scene; theme: Theme; rect: Rect; section: string }
type Tally = { offLine: number; overflow: number; offScale: number }

const GAP_X = 120
const GAP_Y = 280
const SECTION_HEAD = 520
/* A section's name keeps a readable size until it would outgrow its own band. */
const SECTION_TITLE_MAX = 14
/* Below this scale window names give way to the cards' own. */
const TITLE_SCALE = 0.15
/** Below this scale a window is a card: a live App is unreadable and costly. */
const LIVE_SCALE = 0.12
/** Windows mounted at once, and kept mounted after they leave the view. */
const LIVE_MAX = 6
const KEPT_MAX = 10

/** Windows per row: a section wraps rather than running off the board. */
const COLUMNS = 5

const layout = (themes: Themes): { placed: Placed[]; sections: { id: string; title: string; y: number }[]; bounds: Rect } => {
  const placed: Placed[] = []
  const sections: { id: string; title: string; y: number }[] = []
  const shown: Theme[] = themes === 'both' ? ['light', 'dark'] : [themes]
  const perRow = themes === 'both' ? Math.ceil(COLUMNS / 2) : COLUMNS
  const pitch = (WINDOW.width + GAP_X) * shown.length
  let y = 0
  let right = 0
  for (const section of SECTIONS) {
    sections.push({ id: section.id, title: section.title, y })
    y += SECTION_HEAD
    section.scenes.forEach((scene, index) => {
      if (index > 0 && index % perRow === 0) y += WINDOW.height + GAP_X
      const width = scene.width ?? WINDOW.width
      const height = scene.height ?? WINDOW.height
      shown.forEach((theme, which) => {
        const x = (index % perRow) * pitch + which * (WINDOW.width + GAP_X / 3)
        placed.push({ key: `${scene.id}:${theme}`, scene, theme, rect: { x, y, width, height }, section: section.id })
        right = Math.max(right, x + width)
      })
    })
    y += WINDOW.height + GAP_Y
  }
  return { placed, sections, bounds: { x: 0, y: 0, width: right, height: y - GAP_Y } }
}

const sum = (report: GuidesReport): Tally => report.reduce((all, page) => ({
  offLine: all.offLine + page.offLine.length,
  overflow: all.overflow + page.overflow.length,
  offScale: all.offScale + page.offScale.length,
}), { offLine: 0, overflow: 0, offScale: 0 })

const titleOf = (id: string) => {
  for (const section of SECTIONS) for (const scene of section.scenes) if (scene.id === id) return `${section.title} › ${scene.title}`
  return id
}

export const Review = () => {
  const [guides, setGuides] = useGuidesMode()
  const [themes, setThemes] = useState<Themes>(() => (new URLSearchParams(location.search).get('themes') as Themes | null) ?? 'light')
  const [tool, setTool] = useState<Tool>('hand')
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 0.2 })
  const [selected, setSelected] = useState<string | null>(null)
  const [activeNote, setActiveNote] = useState<string | null>(null)
  const [live, setLive] = useState<string[]>([])
  const [tallies, setTallies] = useState<Record<string, Tally>>({})
  // Windows whose scene steps found nothing to act on: they show the wrong state.
  const [missed, setMissed] = useState<Record<string, string[]>>({})
  // As is, or as it would be once every finding the guides can correct is corrected.
  const [view, setView] = useState<'as-is' | 'fixed'>(() => new URLSearchParams(location.search).get('fix') === '1' ? 'fixed' : 'as-is')
  const viewNow = useRef(view)
  viewNow.current = view
  const [fixes, setFixes] = useState<Record<string, string[]>>({})
  const [copied, setCopied] = useState(false)
  const viewport = useRef<HTMLDivElement>(null)
  const frames = useRef(new Map<string, HTMLIFrameElement>())
  /* A window's address is fixed when it first goes live; later guide modes
     travel by message, so changing them never reloads a window. */
  const sources = useRef(new Map<string, string>())
  const sourceOf = (placed: Placed) => {
    let src = sources.current.get(placed.key)
    if (!src) { src = sceneUrl(placed.scene, placed.theme, guidesNow.current); sources.current.set(placed.key, src) }
    return src
  }
  const guidesNow = useRef(guides)
  guidesNow.current = guides
  const notes = useNotes()
  const focusNext = useRef<string | null>(null)
  /* Picks waiting for their window: a note can land on a card, or on a window
     still starting, and asks what is there once the window first reports. */
  const pending = useRef(new Map<string, { id: string; x: number; y: number }[]>())
  const ready = useRef(new Set<Window>())
  const ask = (key: string, pick: { id: string; x: number; y: number }) => {
    const target = frames.current.get(key)?.contentWindow
    if (target && ready.current.has(target)) target.postMessage({ type: 'hd-pick', ...pick }, location.origin)
    else pending.current.set(key, [...(pending.current.get(key) ?? []), pick])
  }
  const board = useMemo(() => layout(themes), [themes])
  const effectiveTool: Tool = spaceHeld ? 'hand' : tool

  const size = () => {
    const box = viewport.current?.getBoundingClientRect()
    return { width: box?.width ?? window.innerWidth, height: box?.height ?? window.innerHeight }
  }
  const focusRect = useCallback((rect: Rect, ceiling = 1) => {
    const { width, height } = size()
    setCamera(fit(rect, width, height, 48, ceiling))
  }, [])
  const focusScene = useCallback((key: string) => {
    const one = board.placed.find((placed) => placed.key === key) ?? board.placed.find((placed) => placed.scene.id === key.split(':')[0])
    if (!one) return
    setSelected(one.key)
    focusRect(one.rect)
  }, [board, focusRect])

  // First view: a deep-linked scene, else the whole board. A theme change
  // keeps the scene being looked at, in its new place.
  const selectedNow = useRef(selected)
  selectedNow.current = selected
  useEffect(() => {
    const scene = selectedNow.current ?? new URLSearchParams(location.search).get('scene')
    if (scene) focusScene(scene)
    else focusRect(board.bounds, 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themes])

  // Which windows run live: those in view, nearest the middle first.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const { width, height } = size()
      if (camera.scale < LIVE_SCALE) return
      const view = visibleRect(camera, width, height)
      const middle = { x: view.x + view.width / 2, y: view.y + view.height / 2 }
      const inView = board.placed
        .filter((one) => intersects(one.rect, view))
        .sort((a, b) => Math.hypot(a.rect.x + a.rect.width / 2 - middle.x, a.rect.y + a.rect.height / 2 - middle.y)
          - Math.hypot(b.rect.x + b.rect.width / 2 - middle.x, b.rect.y + b.rect.height / 2 - middle.y))
        .map((one) => one.key)
      setLive((prior) => {
        // A window on screen is never taken down; new ones fill what is left.
        const staying = prior.filter((key) => inView.includes(key))
        const joining = inView.filter((key) => !staying.includes(key)).slice(0, Math.max(0, LIVE_MAX - staying.length))
        const kept = prior.filter((key) => !inView.includes(key))
        return [...staying, ...joining, ...kept].slice(0, Math.max(KEPT_MAX, staying.length + joining.length))
      })
    }, 160)
    return () => clearTimeout(timer)
  }, [camera, board])

  // The view follows the board's switch into every live window.
  const firstView = useRef(true)
  useEffect(() => {
    if (firstView.current) { firstView.current = false; return }
    for (const frame of frames.current.values()) frame.contentWindow?.postMessage({ type: 'hd-fix', on: view === 'fixed' }, location.origin)
    if (view === 'as-is') setFixes({})
  }, [view])

  // Guides follow the board's dial into every live window.
  useEffect(() => {
    for (const frame of frames.current.values()) frame.contentWindow?.postMessage({ type: 'hd-guides', mode: guides }, location.origin)
    if (guides === 'off') setTallies({})
  }, [guides])

  // Each window reports what its guides found, and what a note points at.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin) return
      const key = [...frames.current].find(([, frame]) => frame.contentWindow === event.source)?.[0]
      if (!key) return
      const data = event.data as { type?: string; report?: GuidesReport; id?: string; element?: string | null; path?: string | null; deltaY?: number; x?: number; y?: number; missed?: string[]; fixes?: string[] }
      if (data.type === 'hd-guides-report' && data.report) {
        if (event.source && !ready.current.has(event.source as Window)) {
          ready.current.add(event.source as Window)
          // A window kept from earlier may have opened under another mode.
          ;(event.source as Window).postMessage({ type: 'hd-guides', mode: guidesNow.current }, location.origin)
          if (viewNow.current === 'fixed') (event.source as Window).postMessage({ type: 'hd-fix', on: true }, location.origin)
        }
        for (const pick of pending.current.get(key) ?? []) (event.source as Window).postMessage({ type: 'hd-pick', ...pick }, location.origin)
        pending.current.delete(key)
        if (guidesNow.current !== 'off') setTallies((prior) => ({ ...prior, [key]: sum(data.report!) }))
      }
      if (data.type === 'hd-fixes' && data.fixes) setFixes((prior) => ({ ...prior, [key]: data.fixes! }))
      if (data.type === 'hd-scene-missed' && data.missed) setMissed((prior) => ({ ...prior, [key]: data.missed! }))
      if (data.type === 'hd-picked' && data.id) updateNote(data.id, { element: data.element ?? null, path: data.path ?? null })
      // A zoom gesture over a running window, in that window's own pixels.
      if (data.type === 'hd-zoom' && typeof data.deltaY === 'number' && typeof data.x === 'number' && typeof data.y === 'number') {
        const frame = frames.current.get(key)
        const box = viewport.current?.getBoundingClientRect()
        if (!frame || !box) return
        const at = frame.getBoundingClientRect()
        const scale = at.width / frame.offsetWidth
        const { deltaY, x, y } = data
        setCamera((prior) => zoomAt(prior, wheelFactor(deltaY), at.left + x * scale - box.left, at.top + y * scale - box.top))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // The wheel: pinch or ⌘ zooms at the pointer, otherwise it pans.
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const box = element.getBoundingClientRect()
      if (event.ctrlKey || event.metaKey) setCamera((prior) => zoomAt(prior, wheelFactor(event.deltaY), event.clientX - box.left, event.clientY - box.top))
      else setCamera((prior) => pan(prior, -event.deltaX, -event.deltaY))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  // The keys a canvas is driven by.
  useEffect(() => {
    const zoomCentre = (factor: number) => {
      const { width, height } = size()
      setCamera((prior) => zoomAt(prior, factor, width / 2, height / 2))
    }
    const onDown = (event: KeyboardEvent) => {
      const target = event.target as Element | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      if (event.code === 'Space' && !event.repeat) { setSpaceHeld(true); event.preventDefault(); return }
      // The inspector's own keys belong to the window under the pointer, which
      // never has focus while the board does.
      if ((event.key === 'Shift' || event.key === 'Escape') && !event.repeat) {
        for (const frame of frames.current.values()) frame.contentWindow?.postMessage({ type: 'hd-key', key: event.key }, location.origin)
      }
      if (event.shiftKey && event.code === 'Digit1') { focusRect(board.bounds, 1); return }
      if (event.shiftKey && event.code === 'Digit0') { const { width, height } = size(); setCamera((prior) => zoomAt(prior, 1 / prior.scale, width / 2, height / 2)); return }
      if (event.shiftKey && event.code === 'Digit2' && selected) { focusScene(selected); return }
      if (event.altKey && event.code === 'KeyG') { event.preventDefault(); setGuides(GUIDES_MODES[(GUIDES_MODES.indexOf(guidesNow.current) + 1) % GUIDES_MODES.length]!); return }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        if (event.code === 'Equal') { event.preventDefault(); zoomCentre(1.25) }
        if (event.code === 'Minus') { event.preventDefault(); zoomCentre(0.8) }
        return
      }
      if (event.key === 'h') setTool('hand')
      if (event.key === 'i') setTool('interact')
      if (event.key === 'c') setTool('comment')
      if (event.key === '+' || event.key === '=') zoomCentre(1.25)
      if (event.key === '-') zoomCentre(0.8)
      if (event.key === 'Escape') { setSelected(null); setActiveNote(null) }
    }
    const onUp = (event: KeyboardEvent) => { if (event.code === 'Space') setSpaceHeld(false) }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp) }
  }, [board, focusRect, focusScene, selected, setGuides])

  // Dragging the board with the hand.
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (effectiveTool !== 'hand' || event.button !== 0) return
    // The toolbar floats over the board; capturing its press would swallow the click.
    if ((event.target as Element).closest('[data-slot="flow-canvas-toolbar"]')) return
    drag.current = { x: event.clientX, y: event.clientY, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current
    if (!start) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (!start.moved && Math.hypot(dx, dy) < 3) return
    start.moved = true
    start.x = event.clientX
    start.y = event.clientY
    setCamera((prior) => pan(prior, dx, dy))
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current
    drag.current = null
    if (!start || start.moved) return
    // A click without a drag selects the window under it.
    const box = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - box.left - camera.x) / camera.scale
    const y = (event.clientY - box.top - camera.y) / camera.scale
    const hit = board.placed.find(({ rect }) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height)
    setSelected(hit?.key ?? null)
  }

  const onComment = (placed: Placed, event: ReactPointerEvent<HTMLDivElement>) => {
    if (effectiveTool !== 'comment') return
    event.stopPropagation()
    // Keep focus where the new note's field will take it, not on the canvas.
    event.preventDefault()
    const box = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - box.left) / camera.scale
    const y = (event.clientY - box.top) / camera.scale
    const note = addNote({ scene: placed.scene.id, theme: placed.theme, x, y, element: null, path: null })
    setActiveNote(note.id)
    focusNext.current = note.id
    setSelected(placed.key)
    setLive((prior) => (prior.includes(placed.key) ? prior : [placed.key, ...prior].slice(0, KEPT_MAX)))
    ask(placed.key, { id: note.id, x, y })
  }

  const goToNote = (note: Note) => {
    setActiveNote(note.id)
    const placed = board.placed.find((one) => one.scene.id === note.scene && one.theme === note.theme) ?? board.placed.find((one) => one.scene.id === note.scene)
    if (placed) { setSelected(placed.key); focusRect(placed.rect) }
  }

  const exportMarkdown = () => {
    void navigator.clipboard?.writeText(notesMarkdown(notes, titleOf)).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }
  const exportJson = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(notes, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'design-review.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  const numbered = new Map(notes.map((note, index) => [note.id, index + 1]))
  const total = Object.values(tallies).reduce((all, one) => ({ offLine: all.offLine + one.offLine, overflow: all.overflow + one.overflow, offScale: all.offScale + one.offScale }), { offLine: 0, overflow: 0, offScale: 0 })

  return (
    <div className={styles.shell} data-review-tool={effectiveTool}>
      <nav className={styles.nav} aria-label="Scenes">
        <div className={styles.brand}>Review</div>
        {SECTIONS.map((section) => (
          <div key={section.id} className={styles.group}>
            <GroupLabel as="div" className={styles.groupLabel}>{section.title}</GroupLabel>
            {section.scenes.map((scene) => {
              const key = `${scene.id}:${themes === 'dark' ? 'dark' : 'light'}`
              const tally = tallies[key]
              const count = tally ? tally.offLine + tally.overflow + tally.offScale : 0
              return (
                <Button key={scene.id} variant="navigation" size="navigation" className={styles.navRow}
                  data-selected={selected?.startsWith(`${scene.id}:`) || undefined}
                  title={scene.query}
                  onClick={() => focusScene(key)}>
                  <span className={styles.navName}>{scene.title}</span>
                  {count > 0 && <span className={styles.navCount}>{count}</span>}
                </Button>
              )
            })}
          </div>
        ))}
      </nav>

      <main className={styles.main}>
        <div className={styles.bar}>
          <div className={styles.dial}>
            <span className={styles.dialLabel}>Guides</span>
            <Segmented label="Guides" value={guides} onChange={(next: GuidesMode) => setGuides(next)} options={GUIDES_MODES.map((one) => ({ value: one, label: one }))} />
          </div>
          <div className={styles.dial}>
            <span className={styles.dialLabel}>View</span>
            <Segmented label="View" value={view} onChange={(next: 'as-is' | 'fixed') => setView(next)}
              options={[{ value: 'as-is', label: 'as is' }, { value: 'fixed', label: 'fixed' }]} />
          </div>
          <div className={styles.dial}>
            <span className={styles.dialLabel}>Theme</span>
            <Segmented label="Theme" value={themes} onChange={setThemes} options={[{ value: 'light', label: 'light' }, { value: 'dark', label: 'dark' }, { value: 'both', label: 'both' }]} />
          </div>
          {guides !== 'off' && (
            <div className={styles.totals} aria-label="What the guides found in the live windows">
              <Chip label={`${total.offLine} off-line`} tone={total.offLine ? 'danger' : 'neutral'} />
              <Chip label={`${total.overflow} overflow`} tone={total.overflow ? 'danger' : 'neutral'} />
              <Chip label={`${total.offScale} off-scale`} tone={total.offScale ? 'warning' : 'neutral'} />
            </div>
          )}
          <span className={styles.zoom} aria-live="polite">{Math.round(camera.scale * 100)}%</span>
        </div>

        <div
          ref={viewport}
          className={styles.viewport}
          data-review-viewport=""
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <div className={styles.board} style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }}>
            {board.sections.map((section) => (
              <div key={section.id} className={styles.sectionTitle} style={{ left: 0, top: section.y + SECTION_HEAD / 3, transform: `scale(${Math.min(1 / camera.scale, SECTION_TITLE_MAX)})` }}>
                {section.title}
              </div>
            ))}
            {board.placed.map((placed) => {
              const tally = tallies[placed.key]
              const isLive = live.includes(placed.key) && camera.scale >= LIVE_SCALE
              const pins = notes.filter((note) => note.scene === placed.scene.id && note.theme === placed.theme)
              return (
                <div key={placed.key} className={styles.frame} data-scene={placed.scene.id} data-theme={placed.theme}
                  data-selected={selected === placed.key || undefined}
                  style={{ left: placed.rect.x, top: placed.rect.y, width: placed.rect.width, height: placed.rect.height }}>
                  {camera.scale >= TITLE_SCALE && <div className={styles.frameTitle} style={{ transform: `scale(${1 / camera.scale})`, maxWidth: placed.rect.width * camera.scale }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => focusScene(placed.key)}>
                    <span>{placed.scene.title}</span>
                    {themes === 'both' && <span className={styles.frameTheme}>{placed.theme}</span>}
                    {view === 'fixed' && fixes[placed.key] && <span className={styles.frameFixed} title={fixes[placed.key]!.join('\n')}>{fixes[placed.key]!.length} fixed</span>}
                    {missed[placed.key] && <span className={styles.frameMissed} title={missed[placed.key]!.join('\n')}>steps missed</span>}
                    {tally && guides !== 'off' && (
                      <span className={styles.frameTally} data-clean={tally.offLine + tally.overflow + tally.offScale === 0 || undefined}>
                        {tally.offLine} off-line · {tally.overflow} overflow · {tally.offScale} off-scale
                      </span>
                    )}
                  </div>}
                  {isLive
                    ? <iframe
                        ref={(element) => { if (element) frames.current.set(placed.key, element); else frames.current.delete(placed.key) }}
                        className={styles.window}
                        title={`${placed.scene.title} (${placed.theme})`}
                        src={sourceOf(placed)}
                        width={placed.rect.width}
                        height={placed.rect.height}
                      />
                    : <div className={styles.placeholder} data-theme={placed.theme}>
                        <span className={styles.placeholderName} style={{ transform: `scale(${1 / camera.scale})`, maxWidth: placed.rect.width * camera.scale }}>{placed.scene.title}</span>
                      </div>}
                  {/* Over the window: catches the comment tool's click, and the hand's. */}
                  <div className={styles.catcher} onPointerDown={(event) => onComment(placed, event)} />
                  {pins.map((note) => (
                    <Button key={note.id} size="icon-circle" variant={activeNote === note.id ? 'danger' : note.done ? 'muted' : 'primary'} className={styles.pin} data-active={activeNote === note.id || undefined} data-done={note.done || undefined}
                      style={{ left: note.x, top: note.y, transform: `translate(-50%, -100%) scale(${1 / camera.scale})` }}
                      aria-label={`Note ${numbered.get(note.id)}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => goToNote(note)}>
                      {numbered.get(note.id)}
                    </Button>
                  ))}
                </div>
              )
            })}
          </div>

          <FlowCanvasToolbar>
              <Button size="icon" variant="ghost" aria-label="Hand" title="Move the board (H, or hold Space)" aria-pressed={tool === 'hand'} onClick={() => setTool('hand')}><CanvasHandIcon /></Button>
              <Button size="icon" variant="ghost" aria-label="Interact" title="Use the windows (I)" aria-pressed={tool === 'interact'} onClick={() => setTool('interact')}><CanvasSelectIcon /></Button>
              <Button size="icon" variant="ghost" aria-label="Comment" title="Pin a note (C)" aria-pressed={tool === 'comment'} onClick={() => setTool('comment')}><CommentIcon /></Button>
              <Button size="icon" variant="ghost" aria-label="Zoom out" title="Zoom out (−)" onClick={() => { const { width, height } = size(); setCamera((prior) => zoomAt(prior, 0.8, width / 2, height / 2)) }}><ZoomOutIcon /></Button>
              <Button size="icon" variant="ghost" aria-label="Zoom in" title="Zoom in (+)" onClick={() => { const { width, height } = size(); setCamera((prior) => zoomAt(prior, 1.25, width / 2, height / 2)) }}><ZoomInIcon /></Button>
              <Button size="icon" variant="ghost" aria-label="Fit everything" title="Fit everything (Shift+1)" onClick={() => focusRect(board.bounds, 1)}><CanvasFitIcon /></Button>
          </FlowCanvasToolbar>
        </div>
      </main>

      <aside className={styles.notes} aria-label="Review notes">
        <div className={styles.notesHead}>
          <span className={styles.notesTitle}>Notes</span>
          <span className={styles.notesCount}>{notes.filter((note) => !note.done).length} open</span>
          <Button size="icon-sm" variant="ghost" aria-label="Copy as Markdown" title={copied ? 'Copied' : 'Copy every note as Markdown'} disabled={!notes.length} onClick={exportMarkdown}>{copied ? <CheckIcon /> : <CopyIcon />}</Button>
          <Button size="icon-sm" variant="ghost" aria-label="Download JSON" title="Download every note as JSON" disabled={!notes.length} onClick={exportJson}><DownloadIcon /></Button>
        </div>
        {notes.length === 0 && <p className={styles.notesEmpty}>Press C, then click a window to pin a note.</p>}
        <ol className={styles.noteList}>
          {notes.map((note) => (
            <li key={note.id} className={styles.note} data-active={activeNote === note.id || undefined} data-done={note.done || undefined}>
              <Button variant="row" size="row" className={styles.noteHead} onClick={() => goToNote(note)}>
                <span className={styles.noteNumber}>{numbered.get(note.id)}</span>
                <span className={styles.noteScene}>{titleOf(note.scene)}{themes === 'both' ? ` · ${note.theme}` : ''}</span>
              </Button>
              {note.element && <code className={styles.noteElement} title={note.path ?? undefined}>{note.element}</code>}
              <Textarea
                aria-label={`Note ${numbered.get(note.id)}`}
                value={note.text}
                placeholder="What should change?"
                ref={(element) => { if (element && focusNext.current === note.id) { focusNext.current = null; requestAnimationFrame(() => element.focus()) } }}
                onFocus={() => setActiveNote(note.id)}
                onChange={(event) => updateNote(note.id, { text: event.target.value })}
              />
              <div className={styles.noteActions}>
                <Button size="sm" variant="ghost" onClick={() => updateNote(note.id, { done: !note.done })}>{note.done ? 'Reopen' : 'Resolve'}</Button>
                <Button size="icon-sm" variant="ghost" aria-label="Delete note" title="Delete this note" onClick={() => removeNote(note.id)}><TrashIcon /></Button>
              </div>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  )
}

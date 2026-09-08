/**
 * The page pointing at something in the desk.
 *
 * A demo band asks the visitor to do one specific thing — open an agent,
 * move a card — and the copy beside it says so in words. This draws the
 * same instruction on the frame: a short label and an arrow to the control
 * it means.
 *
 * Five rules it is built to keep.
 *
 * **It is the page speaking, not the product.** The desk has no coach marks
 * and must not appear to. So this wears the website's language — black,
 * mono, uppercase, the same pill the bands' chips are cut from — and never
 * the app's. Somebody who downloads HarnessDesk after reading the page must
 * not find a feature missing that they only ever saw here.
 *
 * **It never touches the app's DOM.** Targets are found and measured, never
 * styled, wrapped or classed. Everything drawn lives in one layer of this
 * module's own making, `pointer-events: none` throughout, so a hint cannot
 * intercept the very click it is asking for, cannot restyle a component,
 * and leaves nothing behind when it goes.
 *
 * **It only appears where it can be read and obeyed.** Docked at 56% beside
 * the headline, 11px mono is 6px and the frame is a picture rather than a
 * thing to use; the page says so over `hdDocked` and the layer stays empty
 * until the visitor zooms. Off-screen bands never start.
 *
 * **It leaves the moment it is obeyed.** Each hint carries `until`, and the
 * first pointer press inside the frame dismisses whatever is up regardless:
 * the visitor is engaged, which is all it was for. It does not come back.
 * An arrow that outlives its instruction is nagging, and a demo that nags
 * has stopped being a demo.
 *
 * **It follows.** Cards move between columns while a hint is up, so the
 * target is re-measured every frame and the arrow tracks it; a target that
 * scrolls out of view, or is removed, takes its hint with it.
 */

export interface Hint {
  /** The control to point at. Re-run every frame: the answer may move, or arrive late. */
  readonly find: () => Element | null
  /** A few words, imperative. Rendered uppercase; keep it under about four words. */
  readonly text: string
  /** Satisfied → the hint has done its job and goes. Polled with `find`. */
  readonly until?: () => boolean
  /** Which side of the target the label sits on. `auto` takes the roomiest. */
  readonly place?: 'auto' | 'left' | 'right' | 'above' | 'below'
  /** How long to wait before giving up on `find` returning something. Default 12s. */
  readonly waitMs?: number
  /** How long the hint stays once shown, if nothing satisfies it. Default 15s. */
  readonly holdMs?: number
}

interface Chrome {
  /** Whether the frame is docked and scaled down — a picture, not a surface. */
  readonly docked: () => boolean
  /** The theme the embedding page has asked for. */
  readonly theme: () => 'dark' | 'light'
}

const NS = 'http://www.w3.org/2000/svg'
/** Clear of the target, but close enough to read as attached to it. */
const GAP = 16
/** How far the label sits from the target along the chosen side. */
const REACH = 92
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)')

type Side = 'left' | 'right' | 'above' | 'below'

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, style: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  node.setAttribute('style', style)
  return node
}
const svg = <T extends SVGElement>(tag: string, attrs: Record<string, string>): T => {
  const node = document.createElementNS(NS, tag) as T
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  return node
}

/**
 * Which side to put the label on.
 *
 * Most room is not the same as least in the way. A control in a rail has the
 * whole board to its side, so "most room" reaches across and drops the label
 * on the work it is pointing away from; along the rail, above or below, it
 * sits in the rail's own empty space. So a target hugging either edge is
 * labelled vertically, and only a target out in the middle is labelled to
 * the side. A scenario that knows better says so with `place`.
 */
const sideFor = (want: Hint['place'], box: DOMRect): Side => {
  if (want && want !== 'auto') return want
  const mid = box.left + box.width / 2
  const edged = mid < window.innerWidth / 3 || mid > (window.innerWidth * 2) / 3
  const room: Array<[Side, number]> = edged
    ? [
        ['below', window.innerHeight - box.bottom],
        ['above', box.top],
        ['right', window.innerWidth - box.right],
        ['left', box.left],
      ]
    : [
        ['right', window.innerWidth - box.right],
        ['left', box.left],
        ['below', window.innerHeight - box.bottom],
        ['above', box.top],
      ]
  const fits = room.filter(([, space]) => space > REACH + 40)
  return (fits[0] ?? [...room].sort((a, b) => b[1] - a[1])[0])[0]
}

/**
 * Runs hints one at a time, in order.
 *
 * Returns a function that stops everything and removes the layer — the view
 * calls it if the story is torn down, and nothing leaks if it never does.
 */
export const guide = (hints: readonly Hint[], chrome: Chrome): (() => void) => {
  const layer = el('div', 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;contain:strict')
  layer.setAttribute('aria-hidden', 'true')
  document.body.append(layer)

  const canvas = svg<SVGSVGElement>('svg', { width: '100%', height: '100%', fill: 'none' })
  canvas.setAttribute('style', 'position:absolute;inset:0;overflow:visible')
  const ring = svg<SVGRectElement>('rect', { rx: '10', 'stroke-width': '1.5' })
  const line = svg<SVGPathElement>('path', { 'stroke-width': '1.5', 'stroke-linecap': 'round' })
  const head = svg<SVGPathElement>('path', { 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
  canvas.append(ring, line, head)

  const pill = el(
    'div',
    'position:absolute;padding:6px 11px;border-radius:999px;white-space:nowrap;' +
      'font:500 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.18)',
  )
  layer.append(canvas, pill)

  let stopped = false
  let frame = 0
  let index = 0

  const paint = (): void => {
    const dark = chrome.theme() === 'dark'
    // The site's own ink, not the app's: black on paper, inverted in dark.
    const ink = dark ? '#f2efe7' : '#16140f'
    const on = dark ? '#12110e' : '#fbf9f4'
    for (const node of [ring, line, head]) node.setAttribute('stroke', ink)
    ring.setAttribute('stroke-opacity', '0.35')
    pill.style.background = ink
    pill.style.color = on
  }

  const hide = (): void => {
    layer.style.opacity = '0'
  }

  /** One hint, from the moment its target exists to the moment it is done. */
  const run = (hint: Hint): Promise<void> =>
    new Promise((done) => {
      const started = Date.now()
      let shownAt = 0
      let finished = false
      const finish = (): void => {
        if (finished) return
        finished = true
        document.removeEventListener('pointerdown', finish, true)
        hide()
        window.setTimeout(done, REDUCED.matches ? 0 : 220)
      }
      // Any press inside the frame means the visitor is engaged; that is the
      // whole point of the hint, whether or not they pressed the target.
      document.addEventListener('pointerdown', finish, true)

      const tick = (): void => {
        if (stopped || finished) return
        frame = requestAnimationFrame(tick)

        if (hint.until?.()) return finish()

        const target = hint.find()
        const box = target?.getBoundingClientRect()
        const visible =
          box !== undefined &&
          box.width > 0 &&
          box.bottom > 0 &&
          box.top < window.innerHeight &&
          box.right > 0 &&
          box.left < window.innerWidth
        if (!visible || chrome.docked()) {
          // Nothing to point at yet, or nothing worth pointing at: wait,
          // but not forever, and never once it has already been read.
          hide()
          if (shownAt === 0 && Date.now() - started > (hint.waitMs ?? 12_000)) finish()
          if (shownAt !== 0 && Date.now() - shownAt > (hint.holdMs ?? 15_000)) finish()
          return
        }

        if (shownAt === 0) {
          shownAt = Date.now()
          paint()
          layer.style.transition = REDUCED.matches ? 'none' : 'opacity 260ms ease'
        }
        if (Date.now() - shownAt > (hint.holdMs ?? 15_000)) return finish()
        layer.style.opacity = '1'

        // The ring sits just outside the control, so the control itself is
        // never covered or recoloured.
        ring.setAttribute('x', String(box.left - 5))
        ring.setAttribute('y', String(box.top - 5))
        ring.setAttribute('width', String(box.width + 10))
        ring.setAttribute('height', String(box.height + 10))

        const side = sideFor(hint.place, box)
        const mid = { x: box.left + box.width / 2, y: box.top + box.height / 2 }
        // Where the arrow lands: the near edge of the control, plus a gap.
        const tip =
          side === 'right' ? { x: box.right + GAP, y: mid.y }
          : side === 'left' ? { x: box.left - GAP, y: mid.y }
          : side === 'below' ? { x: mid.x, y: box.bottom + GAP }
          : { x: mid.x, y: box.top - GAP }
        const from =
          side === 'right' ? { x: tip.x + REACH, y: tip.y - 26 }
          : side === 'left' ? { x: tip.x - REACH, y: tip.y - 26 }
          : side === 'below' ? { x: tip.x + 30, y: tip.y + REACH * 0.7 }
          : { x: tip.x + 30, y: tip.y - REACH * 0.7 }

        // A single quadratic, bowed away from the control, so the line reads
        // as drawn by hand rather than routed by a diagram tool.
        const bow = side === 'left' || side === 'right' ? { x: (from.x + tip.x) / 2, y: from.y } : { x: from.x, y: (from.y + tip.y) / 2 }
        line.setAttribute('d', `M ${from.x} ${from.y} Q ${bow.x} ${bow.y} ${tip.x} ${tip.y}`)

        const angle = Math.atan2(tip.y - bow.y, tip.x - bow.x)
        const wing = (turn: number): string =>
          `${tip.x - 9 * Math.cos(angle + turn)} ${tip.y - 9 * Math.sin(angle + turn)}`
        head.setAttribute('d', `M ${wing(0.45)} L ${tip.x} ${tip.y} L ${wing(-0.45)}`)

        pill.textContent = hint.text
        const size = pill.getBoundingClientRect()
        const left =
          side === 'right' ? from.x - 12
          : side === 'left' ? from.x - size.width + 12
          : from.x - size.width / 2
        const top = side === 'above' || side === 'below' ? from.y - size.height / 2 : from.y - size.height - 8
        // Never off the edge of the frame.
        pill.style.left = `${Math.max(8, Math.min(left, window.innerWidth - size.width - 8))}px`
        pill.style.top = `${Math.max(8, Math.min(top, window.innerHeight - size.height - 8))}px`
      }
      tick()
    })

  void (async () => {
    for (; index < hints.length; index += 1) {
      if (stopped) break
      await run(hints[index])
      if (stopped) break
      await new Promise((r) => window.setTimeout(r, 420))
    }
    layer.remove()
  })()

  return () => {
    stopped = true
    cancelAnimationFrame(frame)
    layer.remove()
  }
}

/**
 * Annotating a page in the browser pane: comments on elements, on regions,
 * and freehand marks.
 *
 * Both incumbents have this and it is the same gesture in each: point at the
 * thing you mean instead of describing it. Codex's is a comment left on an
 * element or a dragged region, which it sends with a screenshot where that
 * element is outlined and numbered; Claude Code's is a pen over a screenshot.
 * The message they compose out of it is the same species — a block of
 * context beside the sentence — which is exactly what this desk already sends
 * as `<context source=…>` and renders as a folded "Context added" row.
 *
 * So the mechanism is not new. What is new is the gesture, and it has to
 * happen *inside the page*: a `<webview>` is opaque to the window around it,
 * so an overlay drawn in the renderer could paint over the page but never
 * know what is under the pointer. The overlay below is therefore injected
 * into the guest, which also makes the screenshot free — `capturePage`
 * photographs the marks because they are part of the page by then, the same
 * way Codex's marker screenshots are.
 *
 * Injected into an *isolated world* of the guest, specifically — the desktop
 * shell runs it there by `webContents` id. The DOM is shared, which is the
 * point; the JavaScript is not, so the page can neither see `__hdAnnotate`
 * nor answer in its place, and what `list` returns comes from this closure
 * rather than from anything the page planted on `window`. The marks
 * themselves live in the shared DOM — a page could move or hide them, which
 * a person would see — but it cannot fabricate the record of them. What
 * comes back still passes `readAnnotations` below: the guest is a renderer
 * process, and a boundary that trusts one is not a boundary.
 */

/** What one annotation is, once the page hands it back. */
export interface PageAnnotation {
  /** 1, 2, 3 — the number drawn on the picture beside it. */
  readonly n: number
  readonly kind: 'element' | 'region' | 'drawing'
  /** What the person wrote. Empty is allowed: a mark can speak for itself. */
  readonly comment: string
  /** The element's own words, trimmed — what a person would call it. */
  readonly target?: string
  readonly selector?: string
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly viewport: { readonly width: number; readonly height: number }
  readonly strokes?: number
}

/** The label the fold wears in the transcript. */
export const ANNOTATION_LABEL = 'Page annotations'

// What one page's marks may amount to. Generous for a person — nobody
// numbers a hundred comments by hand — and a ceiling for anything else.
const MAX_ANNOTATIONS = 100
const MAX_COMMENT = 4000
const MAX_TARGET = 200
const MAX_SELECTOR = 500

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null

const boxOf = (value: unknown): PageAnnotation['rect'] | null => {
  const raw = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null
  const x = finite(raw?.x)
  const y = finite(raw?.y)
  const width = finite(raw?.width)
  const height = finite(raw?.height)
  if (x === null || y === null || width === null || height === null) return null
  return { x, y, width, height }
}

const sizeOf = (value: unknown): { width: number; height: number } | null => {
  const raw = value as { width?: unknown; height?: unknown } | null
  const width = finite(raw?.width)
  const height = finite(raw?.height)
  if (width === null || height === null) return null
  return { width, height }
}

/**
 * What came back from the page, believed only as far as it is shaped: the
 * overlay runs in an isolated world, but it still runs in the guest's
 * renderer process, and its answer becomes agent context. Anything
 * malformed is dropped; everything kept is size-capped, so a compromised
 * guest can neither smuggle structure nor flood the composer.
 */
export const readAnnotations = (value: unknown): PageAnnotation[] => {
  if (!Array.isArray(value)) return []
  const out: PageAnnotation[] = []
  for (const entry of value.slice(0, MAX_ANNOTATIONS)) {
    const raw = entry as {
      n?: unknown
      kind?: unknown
      comment?: unknown
      target?: unknown
      selector?: unknown
      rect?: unknown
      viewport?: unknown
      strokes?: unknown
    } | null
    const n = finite(raw?.n)
    const kind = raw?.kind
    const rect = boxOf(raw?.rect)
    const viewport = sizeOf(raw?.viewport)
    if (n === null || n < 1) continue
    if (kind !== 'element' && kind !== 'region' && kind !== 'drawing') continue
    if (!rect || !viewport) continue
    const strokes = finite(raw?.strokes)
    out.push({
      n,
      kind,
      comment: typeof raw?.comment === 'string' ? raw.comment.slice(0, MAX_COMMENT) : '',
      ...(typeof raw?.target === 'string' && raw.target.length > 0
        ? { target: raw.target.slice(0, MAX_TARGET) }
        : {}),
      ...(typeof raw?.selector === 'string' && raw.selector.length > 0
        ? { selector: raw.selector.slice(0, MAX_SELECTOR) }
        : {}),
      rect,
      viewport,
      ...(strokes !== null && strokes >= 0 ? { strokes } : {}),
    })
  }
  return out
}

/**
 * The overlay, written as a function and shipped as its own text.
 *
 * `executeJavaScript` takes a string, and a string is where three hundred
 * lines of overlay stop being typechecked and start being a typo nobody
 * sees until a page misbehaves. Written this way the compiler reads it. The
 * one rule that follows from stringifying it: everything it needs is inside
 * it, because a reference to anything in this module would be a reference to
 * nothing at all once it lands in the guest.
 */
function overlay(): void {
  const KEY = '__hdAnnotate'
  const scope = window as unknown as Record<string, unknown>
  const already = scope[KEY] as { start?: () => void } | undefined
  if (already && typeof already.start === 'function') {
    already.start()
    return
  }

  const MARK = 'data-hd-annotate'
  const BLUE = '#2563eb'
  const RED = '#e11d48'
  const TOP = 2147483600

  interface Item {
    n: number
    kind: 'element' | 'region' | 'drawing'
    comment: string
    target?: string
    selector?: string
    rect: { x: number; y: number; width: number; height: number }
    viewport: { width: number; height: number }
    strokes?: number
  }

  interface Placed {
    item: Item
    /** Kept for an element, so its box is re-measured rather than remembered. */
    element: Element | null
    /** Page-space box, for the marks that have no element to ask. */
    page: { x: number; y: number; width: number; height: number }
    box: HTMLDivElement
    badge: HTMLDivElement
  }

  type Stroke = { x: number; y: number }[]

  let mode: 'comment' | 'draw' = 'comment'
  let running = false
  let count = 0
  const placed: Placed[] = []
  const strokes: Stroke[] = []
  let drawing: Stroke | null = null
  let strokesTaken = 0
  let down: { x: number; y: number } | null = null

  const make = (tag: string, style: Partial<CSSStyleDeclaration>): HTMLElement => {
    const node = document.createElement(tag)
    node.setAttribute(MARK, '')
    Object.assign(node.style, style)
    return node
  }

  // Three layers, because the pointer wants three different answers: one
  // surface that swallows every click so a link never fires while you are
  // pointing at it, one that draws and must never take a click, and one that
  // holds the little input, which must.
  const layer = make('div', {
    position: 'fixed',
    left: '0',
    top: '0',
    right: '0',
    bottom: '0',
    zIndex: String(TOP),
    cursor: 'crosshair',
    display: 'none',
  })
  const marks = make('div', {
    position: 'fixed',
    left: '0',
    top: '0',
    right: '0',
    bottom: '0',
    zIndex: String(TOP + 1),
    pointerEvents: 'none',
    display: 'none',
  })
  const ui = make('div', {
    position: 'fixed',
    left: '0',
    top: '0',
    right: '0',
    bottom: '0',
    zIndex: String(TOP + 2),
    pointerEvents: 'none',
    display: 'none',
  })

  const canvas = make('canvas', {
    position: 'absolute',
    left: '0',
    top: '0',
    width: '100%',
    height: '100%',
  }) as HTMLCanvasElement
  marks.appendChild(canvas)

  const hover = make('div', {
    position: 'absolute',
    border: '1px solid ' + BLUE,
    background: 'rgba(37, 99, 235, 0.08)',
    borderRadius: '2px',
    display: 'none',
  })
  marks.appendChild(hover)

  const box = (kind: 'element' | 'region'): HTMLDivElement =>
    make('div', {
      position: 'absolute',
      border: (kind === 'region' ? '2px dashed ' : '2px solid ') + BLUE,
      borderRadius: '3px',
      background: 'rgba(37, 99, 235, 0.06)',
    }) as HTMLDivElement

  const badge = (n: number): HTMLDivElement => {
    const node = make('div', {
      position: 'absolute',
      minWidth: '18px',
      height: '18px',
      padding: '0 4px',
      borderRadius: '9px',
      background: BLUE,
      color: '#fff',
      font: '600 11px/18px ui-sans-serif, system-ui, sans-serif',
      textAlign: 'center',
      boxSizing: 'border-box',
    }) as HTMLDivElement
    node.textContent = String(n)
    return node
  }

  /**
   * The page under the pointer, with our own furniture stepped out of the way.
   *
   * Only the event surface is lifted, and it is put back exactly as it was:
   * the layer holding the little input keeps `pointer-events: none` for its
   * whole life — the input inside it turns them back on for itself — and
   * setting the layer to `auto` here once left a transparent sheet over the
   * page that ate every click after the first move.
   */
  const pick = (x: number, y: number): Element | null => {
    layer.style.pointerEvents = 'none'
    const found = document.elementFromPoint(x, y)
    layer.style.pointerEvents = 'auto'
    if (!found || found.closest('[' + MARK + ']')) return null
    return found
  }

  /**
   * A path an agent can act on: a few steps, an id when there is one, and the
   * ordinal among same-tag siblings — enough to find the element again, and
   * short enough to read in a sentence.
   */
  const selectorOf = (element: Element): string => {
    const parts: string[] = []
    let node: Element | null = element
    while (node && node.nodeType === 1 && parts.length < 5) {
      const tag = node.tagName.toLowerCase()
      if (node.id) {
        parts.unshift(tag + '#' + node.id)
        break
      }
      let part = tag
      const classes = (node.getAttribute('class') || '')
        .split(/\s+/)
        .filter((name) => name.length > 0 && name.length < 24)
        .slice(0, 2)
      if (classes.length > 0) part += '.' + classes.join('.')
      const parent: Element | null = node.parentElement
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, (child: Element) => child.tagName === node!.tagName)
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      if (!parent || parent === document.body) break
      node = parent
    }
    return parts.join(' > ')
  }

  const wordsOf = (element: Element): string => {
    const text = ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/g, ' ').trim()
    return text.length > 80 ? text.slice(0, 80) + '…' : text
  }

  const viewport = (): { width: number; height: number } => ({
    width: Math.round(document.documentElement.clientWidth),
    height: Math.round(document.documentElement.clientHeight),
  })

  const round = (rect: { x: number; y: number; width: number; height: number }) => ({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  })

  const paint = (): void => {
    const ratio = window.devicePixelRatio || 1
    const size = viewport()
    canvas.width = Math.round(size.width * ratio)
    canvas.height = Math.round(size.height * ratio)
    const pen = canvas.getContext('2d')
    if (!pen) return
    pen.setTransform(ratio, 0, 0, ratio, 0, 0)
    pen.clearRect(0, 0, size.width, size.height)
    pen.strokeStyle = RED
    pen.lineWidth = 3
    pen.lineCap = 'round'
    pen.lineJoin = 'round'
    const all = drawing ? strokes.concat([drawing]) : strokes
    for (const stroke of all) {
      if (stroke.length === 0) continue
      pen.beginPath()
      stroke.forEach((point, index) => {
        const x = point.x - window.scrollX
        const y = point.y - window.scrollY
        if (index === 0) pen.moveTo(x, y)
        else pen.lineTo(x, y)
      })
      pen.stroke()
    }
  }

  /**
   * Marks follow the page. An element is asked where it is now — reflow moves
   * things, and a remembered rectangle would end up pointing at whatever
   * slid into its place; everything else is held in page coordinates and
   * offset by the scroll.
   */
  const reposition = (): void => {
    for (const entry of placed) {
      const rect = entry.element
        ? entry.element.getBoundingClientRect()
        : {
            left: entry.page.x - window.scrollX,
            top: entry.page.y - window.scrollY,
            width: entry.page.width,
            height: entry.page.height,
          }
      entry.box.style.left = rect.left + 'px'
      entry.box.style.top = rect.top + 'px'
      entry.box.style.width = rect.width + 'px'
      entry.box.style.height = rect.height + 'px'
      entry.badge.style.left = Math.max(2, rect.left - 8) + 'px'
      entry.badge.style.top = Math.max(2, rect.top - 8) + 'px'
    }
    paint()
  }

  const bubble = make('div', {
    position: 'absolute',
    display: 'none',
    alignItems: 'center',
    gap: '6px',
    maxWidth: '320px',
    padding: '6px 6px 6px 10px',
    borderRadius: '10px',
    background: '#ffffff',
    boxShadow: '0 6px 24px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.06)',
    font: '13px/1.4 ui-sans-serif, system-ui, sans-serif',
    color: '#111111',
    pointerEvents: 'auto',
  })
  const field = make('input', {
    width: '220px',
    border: 'none',
    outline: 'none',
    background: 'transparent',
    font: 'inherit',
    color: 'inherit',
  }) as HTMLInputElement
  field.placeholder = 'Add a comment…'
  const accept = make('button', {
    width: '24px',
    height: '24px',
    border: 'none',
    borderRadius: '12px',
    background: BLUE,
    color: '#fff',
    font: '13px/1 ui-sans-serif, system-ui, sans-serif',
    cursor: 'pointer',
  }) as HTMLButtonElement
  accept.textContent = '↵'
  accept.type = 'button'
  bubble.appendChild(field)
  bubble.appendChild(accept)
  ui.appendChild(bubble)

  let pending: { kind: 'element' | 'region' | 'drawing'; element: Element | null; rect: DOMRect | { left: number; top: number; width: number; height: number } } | null = null

  const closeBubble = (): void => {
    pending = null
    bubble.style.display = 'none'
    field.value = ''
  }

  const openBubble = (at: { left: number; top: number; width: number; height: number }): void => {
    bubble.style.display = 'flex'
    const size = viewport()
    const width = 300
    bubble.style.left = Math.max(8, Math.min(at.left, size.width - width - 8)) + 'px'
    bubble.style.top = Math.max(8, Math.min(at.top + at.height + 8, size.height - 52)) + 'px'
    field.focus()
  }

  const commit = (): void => {
    if (!pending) return
    const rect = pending.rect
    const size = viewport()
    const item: Item = {
      n: ++count,
      kind: pending.kind,
      comment: field.value.trim(),
      rect: round({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }),
      viewport: size,
    }
    if (pending.element) {
      item.target = wordsOf(pending.element)
      item.selector = selectorOf(pending.element)
    }
    if (pending.kind === 'drawing') item.strokes = strokes.length - strokesTaken

    const shape = box(pending.kind === 'region' ? 'region' : 'element')
    // A drawing is its own mark; a box around the strokes would only fence
    // in what the person already drew.
    if (pending.kind === 'drawing') shape.style.border = 'none'
    const number = badge(item.n)
    marks.appendChild(shape)
    marks.appendChild(number)
    placed.push({
      item,
      element: pending.element,
      page: {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
      box: shape,
      badge: number,
    })
    if (pending.kind === 'drawing') strokesTaken = strokes.length
    closeBubble()
    reposition()
  }

  field.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeBubble()
    }
  })
  accept.addEventListener('click', () => commit())

  const onMove = (event: MouseEvent): void => {
    if (mode === 'draw') {
      if (drawing) {
        drawing.push({ x: event.clientX + window.scrollX, y: event.clientY + window.scrollY })
        paint()
      }
      return
    }
    if (down || bubble.style.display === 'flex') return
    const element = pick(event.clientX, event.clientY)
    if (!element) {
      hover.style.display = 'none'
      return
    }
    const rect = element.getBoundingClientRect()
    hover.style.display = 'block'
    hover.style.left = rect.left + 'px'
    hover.style.top = rect.top + 'px'
    hover.style.width = rect.width + 'px'
    hover.style.height = rect.height + 'px'
  }

  const onDown = (event: MouseEvent): void => {
    event.preventDefault()
    if (bubble.style.display === 'flex') closeBubble()
    if (mode === 'draw') {
      drawing = [{ x: event.clientX + window.scrollX, y: event.clientY + window.scrollY }]
      return
    }
    down = { x: event.clientX, y: event.clientY }
  }

  const onUp = (event: MouseEvent): void => {
    if (mode === 'draw') {
      if (!drawing) return
      if (drawing.length > 1) strokes.push(drawing)
      drawing = null
      paint()
      // The pen asks for its comment where the hand stopped, once, for
      // however many strokes have been drawn since the last one.
      if (strokes.length > strokesTaken) {
        pending = {
          kind: 'drawing',
          element: null,
          rect: { left: event.clientX, top: event.clientY, width: 0, height: 0 },
        }
        openBubble({ left: event.clientX, top: event.clientY, width: 0, height: 0 })
      }
      return
    }
    const start = down
    down = null
    if (!start) return
    const dx = Math.abs(event.clientX - start.x)
    const dy = Math.abs(event.clientY - start.y)
    hover.style.display = 'none'
    // A drag is a region; anything under a few pixels was a click at an
    // element, because nobody drags a six-pixel box on purpose.
    if (dx > 6 || dy > 6) {
      const rect = {
        left: Math.min(start.x, event.clientX),
        top: Math.min(start.y, event.clientY),
        width: dx,
        height: dy,
      }
      pending = { kind: 'region', element: null, rect }
      openBubble(rect)
      return
    }
    const element = pick(event.clientX, event.clientY)
    if (!element) return
    const rect = element.getBoundingClientRect()
    pending = { kind: 'element', element, rect }
    openBubble(rect)
  }

  layer.addEventListener('mousemove', onMove, true)
  layer.addEventListener('mousedown', onDown, true)
  layer.addEventListener('mouseup', onUp, true)
  layer.addEventListener('click', (event: MouseEvent) => event.preventDefault(), true)
  window.addEventListener('scroll', reposition, true)
  window.addEventListener('resize', reposition)

  const show = (visible: boolean): void => {
    const value = visible ? 'block' : 'none'
    layer.style.display = value
    marks.style.display = value
    ui.style.display = value
  }

  const clear = (): void => {
    for (const entry of placed) {
      entry.box.remove()
      entry.badge.remove()
    }
    placed.length = 0
    strokes.length = 0
    strokesTaken = 0
    drawing = null
    count = 0
    closeBubble()
    paint()
  }

  const start = (): void => {
    if (!document.body.contains(layer)) {
      document.body.appendChild(layer)
      document.body.appendChild(marks)
      document.body.appendChild(ui)
    }
    running = true
    show(true)
    paint()
  }

  scope[KEY] = {
    start,
    stop: (): void => {
      running = false
      clear()
      show(false)
    },
    clear,
    running: (): boolean => running,
    setMode: (next: string): void => {
      mode = next === 'draw' ? 'draw' : 'comment'
      hover.style.display = 'none'
      layer.style.cursor = 'crosshair'
      closeBubble()
    },
    /** Everything but the marks, for the moment the picture is taken. */
    prepare: (): void => {
      hover.style.display = 'none'
      closeBubble()
    },
    list: (): Item[] => placed.map((entry) => entry.item),
  }

  start()
}

/** The overlay's source, ready for `executeJavaScript`. */
export const ANNOTATE_SOURCE = `(${overlay.toString()})(); true`

/** One call into the installed overlay, or a no-op where it is not. */
export const annotateCall = (method: string, argument?: string): string =>
  `(window.__hdAnnotate ? window.__hdAnnotate.${method}(${argument === undefined ? '' : JSON.stringify(argument)}) : null)`

/** Whether the overlay is installed and running in this document. */
export const ANNOTATE_ALIVE = `!!(window.__hdAnnotate && window.__hdAnnotate.running())`

const place = (annotation: PageAnnotation): string =>
  `(${annotation.rect.x}, ${annotation.rect.y}) in ${annotation.viewport.width}x${annotation.viewport.height} viewport`

/**
 * The block that travels with the picture.
 *
 * Shaped after what the agents' own apps compose for the same gesture —
 * heading, numbered comments, the target and where it sits — because that
 * shape is already what these models read every day, and because a person
 * reading the fold in the transcript recognises what they pointed at.
 */
export const annotationContext = (
  page: { readonly title: string; readonly url: string },
  annotations: readonly PageAnnotation[],
  options: { readonly withImage: boolean } = { withImage: true },
): string => {
  const lines: string[] = ['# Page annotations:', '']
  lines.push(`Page: ${page.title || page.url}`)
  lines.push(`Page URL: ${page.url}`)
  lines.push(
    options.withImage
      ? 'The attached image is a screenshot of that page with these marks drawn on it, each numbered to match the comments below.'
      : 'The marks are described below; this agent takes no images, so the screenshot was not attached.',
  )

  for (const annotation of annotations) {
    lines.push('')
    lines.push(`## ${annotation.kind === 'drawing' ? 'Drawing' : 'Comment'} ${annotation.n}`)
    if (annotation.kind === 'element') {
      if (annotation.target) lines.push(`Target: ${JSON.stringify(annotation.target)}`)
      if (annotation.selector) lines.push(`Target selector: ${annotation.selector}`)
      lines.push(`Node position: ${place(annotation)}`)
    } else if (annotation.kind === 'region') {
      lines.push(`Region: ${annotation.rect.width} × ${annotation.rect.height} at ${place(annotation)}`)
    } else {
      const strokes = annotation.strokes ?? 0
      lines.push(`Freehand marks: ${strokes} ${strokes === 1 ? 'stroke' : 'strokes'}, around ${place(annotation)}`)
    }
    if (annotation.comment.length > 0) {
      lines.push('Comment:')
      lines.push(annotation.comment)
    }
  }

  return lines.join('\n')
}

/** What the pane says when it hands the annotations over. */
export const annotationSummary = (annotations: readonly PageAnnotation[]): string => {
  const drawings = annotations.filter((entry) => entry.kind === 'drawing').length
  const comments = annotations.length - drawings
  const parts: string[] = []
  if (comments > 0) parts.push(`${comments} comment${comments === 1 ? '' : 's'}`)
  if (drawings > 0) parts.push(`${drawings} drawing${drawings === 1 ? '' : 's'}`)
  return parts.join(' and ')
}

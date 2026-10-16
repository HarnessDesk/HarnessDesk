/**
 * The few clicks that turn a frame-wall route into one particular state — a
 * Team tab, a side tool open, a menu showing — run by the page itself.
 *
 * The browser specs reach these states with Playwright (`e2e/ui-system/*
 * -actions.ts`); the review board needs them without a driver, inside an
 * iframe, so a scene names its steps in `?steps=` and the preview plays them
 * after it mounts. Each step waits for its target, because the App publishes
 * its layout over a few frames.
 */

export type SceneStep =
  /** Click the first visible match. */
  | { readonly click: string }
  /** Click the first visible match unless `unless` is already on the page. */
  | { readonly click: string; readonly unless: string }
  /** Click the first visible match of `within` whose text is exactly `text`. */
  | { readonly text: string; readonly within: string }
  /** Focus the first visible match, then press a key on it. */
  | { readonly focus: string; readonly key: string }
  /** Move the pointer onto the first visible match. */
  | { readonly hover: string }

const shown = (el: Element) => {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

const find = async (selector: string, text?: string, timeout = 3000): Promise<HTMLElement | null> => {
  const start = performance.now()
  while (performance.now() - start < timeout) {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (!shown(el)) continue
      if (text !== undefined && (el.textContent ?? '').trim() !== text && el.getAttribute('aria-label') !== text) continue
      return el
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 120))))

/**
 * A click, then — if nothing opened — the whole press a pointer makes. Every
 * trigger here answers a plain click; the press is for one that waits for it.
 */
const press = async (el: HTMLElement) => {
  const popups = () => document.querySelectorAll('[data-popup-kind]').length
  const before = popups()
  el.click()
  await settle()
  if (popups() > before || el.getAttribute('aria-expanded') === 'true' || !el.matches('[aria-haspopup], [data-slot$="trigger"]')) return
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    el.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', isPrimary: true, pointerId: 1 } as PointerEventInit))
  }
  el.click()
}

/**
 * Wait until the page stops moving. The App publishes its window size and
 * layout over its first frames, and publishing it dismisses open overlays, so
 * a menu opened before then is shut again a moment later.
 */
const quiet = async () => {
  await document.fonts.ready
  const shape = () => [...document.querySelectorAll('#root *')].slice(0, 4000)
    .map((el) => { const r = el.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}` }).join('|')
  const deadline = performance.now() + 5000
  let previous = shape()
  let calm = 0
  while (calm < 4 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const next = shape()
    calm = next === previous ? calm + 1 : 0
    previous = next
  }
}

export const runSceneSteps = async (steps: readonly SceneStep[]) => {
  document.documentElement.dataset.sceneSteps = 'running'
  await quiet()
  for (const step of steps) {
    await settle()
    if ('focus' in step) {
      const el = await find(step.focus)
      if (!el) continue
      el.focus()
      el.dispatchEvent(new KeyboardEvent('keydown', { key: step.key, code: step.key, bubbles: true, cancelable: true, shiftKey: step.key === 'F10' }))
    } else if ('hover' in step) {
      const el = await find(step.hover)
      if (!el) continue
      for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove']) el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'mouse' }))
    } else if ('text' in step) {
      const el = await find(step.within, step.text)
      if (el) await press(el)
    } else {
      if ('unless' in step && document.querySelector(step.unless)) continue
      const el = await find(step.click)
      if (el) await press(el)
    }
  }
  await settle()
  document.documentElement.dataset.sceneSteps = 'done'
}

/** The steps a page was opened with, if any. */
export const requestedSteps = (): SceneStep[] | null => {
  const raw = new URLSearchParams(window.location.search).get('steps')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed as SceneStep[] : null
  } catch { return null }
}

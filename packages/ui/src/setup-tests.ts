/**
 * What jsdom does not implement, and the renderer legitimately uses.
 *
 * None of these is a mock of app behaviour: `scrollIntoView`,
 * `ResizeObserver` and a working `localStorage` are browser APIs this jsdom
 * omits or leaves half-built, and a component that measures itself, scrolls a
 * tab into view, or remembers that you put a banner away would otherwise
 * throw on mount for a reason that has nothing to do with what is being
 * tested. Guarding every call site instead would put test-shaped code in the
 * renderer.
 */

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

if (!('ResizeObserver' in globalThis)) {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
}

// jsdom here hands back a `localStorage` with no `clear`, which is worse than
// none at all: code that feature-detects it finds it and then falls over.
if (typeof globalThis.localStorage?.clear !== 'function') {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, String(value)),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size
      },
    },
  })
}

/*
 * jsdom implements no `PointerEvent` at all — not a partial one, none.
 *
 * Base UI's switch (and anything else of its that re-dispatches a click while
 * preserving modifier keys) constructs one on the element's own window. That
 * is correct browser code; it throws here with
 * `ownerWindow(...).PointerEvent is not a constructor`, and the throw surfaces
 * miles from its cause — as a failure inside whichever test happened to click
 * a switch.
 *
 * A `MouseEvent` subclass carrying the pointer fields is enough: nothing in
 * this app reads pressure or tilt, and the alternative — teaching the
 * components to feature-detect a constructor the browser always has — would
 * put test-shaped code in the renderer.
 */
if (!('PointerEvent' in globalThis)) {
  class PointerEventShim extends MouseEvent {
    readonly pointerId: number
    readonly pointerType: string
    readonly isPrimary: boolean
    readonly width: number
    readonly height: number
    readonly pressure: number

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 0
      this.pointerType = init.pointerType ?? ''
      this.isPrimary = init.isPrimary ?? false
      this.width = init.width ?? 1
      this.height = init.height ?? 1
      this.pressure = init.pressure ?? 0
    }
  }
  ;(globalThis as { PointerEvent?: unknown }).PointerEvent = PointerEventShim
  // The components read it off the element's own window, not off globalThis.
  if (typeof window !== 'undefined') {
    ;(window as unknown as { PointerEvent?: unknown }).PointerEvent = PointerEventShim
  }
}

/*
 * Pointer capture, which jsdom implements as nothing at all.
 *
 * A resize seam takes the pointer on `pointerdown` and hands it back on
 * `pointerup` — that is the only thing keeping a drag alive once the pointer
 * has left the one-pixel line it started on. jsdom has no such methods, so a
 * test that drags a seam throws before the drag begins, and guarding the call
 * in the component would put test-shaped code in the renderer. A set of held
 * ids is the whole of the behaviour anything here reads back.
 */
if (!Element.prototype.setPointerCapture) {
  const held = new WeakMap<Element, Set<number>>()
  Element.prototype.setPointerCapture = function (this: Element, id: number): void {
    const ids = held.get(this) ?? new Set<number>()
    ids.add(id)
    held.set(this, ids)
  }
  Element.prototype.releasePointerCapture = function (this: Element, id: number): void {
    held.get(this)?.delete(id)
  }
  Element.prototype.hasPointerCapture = function (this: Element, id: number): boolean {
    return held.get(this)?.has(id) ?? false
  }
}

// jsdom ships no `matchMedia` at all. Anything that resolves a theme asks for
// `(prefers-color-scheme: dark)` — which is now anything that renders markdown,
// since a code fence is highlighted for the theme it is being read in. Light,
// and a listener that never fires: these tests do not change the OS theme.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    // Writable, because a test that wants to drive the theme replaces this.
    writable: true,
    value: (media: string) => ({
      media,
      matches: false,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

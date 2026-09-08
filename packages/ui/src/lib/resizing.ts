/**
 * The window, while a seam is being dragged.
 *
 * A resize is the one gesture in this app that must not go through React at
 * all. The size being dragged is a number the layout store owns, but writing
 * it there sixty times a second rebuilds the workbench, re-renders every
 * mounted view and queues a persist — for a value only the last one of which
 * matters. So the seams drag a CSS custom property straight on the DOM and the
 * store hears the number they land on; see `AreaSeam` and the split views.
 *
 * That leaves three things that still have to stop for the length of a drag,
 * and none of them is any one seam's business:
 *
 *   Transitions    The sidebar animates its width, so that collapsing it
 *                  slides rather than jumps. Animating it *while it is being
 *                  dragged* makes the column chase the pointer half a second
 *                  behind — which is what a resize that felt like treacle was.
 *   Selection      A pointer dragged across a transcript selects it: the
 *                  cursor becomes a caret, text turns blue, and letting go
 *                  leaves a selection nobody asked for.
 *   Guest frames   An `<iframe>` and Electron's `<webview>` hit-test in their
 *                  own process, and pointer capture does not reach in there.
 *                  A seam dragged over the browser pane stopped getting moves
 *                  and the drag died mid-gesture.
 *
 * An attribute on the root element rather than React state, for the same
 * reason the sizes are: a drag must re-render nothing. The rules it turns on
 * live in `styles/app.css`, next to the rest of the app's globals.
 */

const FLAG = 'data-hd-resizing'

/**
 * How many drags are in flight.
 *
 * Counted rather than set and cleared, because the flag is one attribute and a
 * drag is not necessarily alone. Two pointers can hold two seams at once —
 * unlikely on a 9px target, but `setPointerCapture` locks *a* pointer to an
 * element, not the window — and with a plain boolean the first one to finish
 * would strip the flag while the second was still dragging, handing that drag
 * back the transitions, the caret and the live iframes it had turned off.
 *
 * Two drags on different axes leave the cursor to the one that started; a
 * forced `col-resize` while a second finger drags a horizontal seam is a
 * smaller wrong than no suppression at all.
 */
let depth = 0

/** Marks the window as mid-resize, and says which way the pointer is going. */
export const beginResize = (orientation: 'vertical' | 'horizontal'): void => {
  depth += 1
  if (depth === 1) document.documentElement.setAttribute(FLAG, orientation)
}

/**
 * Gives one drag's suppression back.
 *
 * Every caller pairs this with its own `beginResize`, and every caller must
 * reach it exactly once however its gesture ended — pointer up, pointer
 * cancel, capture lost, or the seam unmounting under the pointer. The seams
 * make their teardown idempotent for that reason: a drag that ends twice would
 * otherwise borrow a second drag's suppression, and one that never ends leaves
 * the whole window with no transitions, a frozen cursor and inert guest
 * frames, which is the worst state this file can produce.
 */
export const endResize = (): void => {
  depth = Math.max(0, depth - 1)
  if (depth === 0) document.documentElement.removeAttribute(FLAG)
}

/**
 * `data-dragging`, set on a node without a render.
 *
 * The seam and the split it sits in both light up while they are being
 * dragged. That is a visual, so it belongs in CSS — but the boolean behind it
 * would be React state, and one `useState` per drag start is one render of
 * every pane inside the split. The attribute goes on directly instead.
 */
export const markDragging = (node: Element | null | undefined, on: boolean): void => {
  if (!node) return
  if (on) node.setAttribute('data-dragging', '')
  else node.removeAttribute('data-dragging')
}

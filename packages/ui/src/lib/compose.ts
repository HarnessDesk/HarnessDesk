/**
 * Handing something to the conversation's composer from another pane.
 *
 * The composer listens for `harnessdesk:compose` only while its own pane
 * has the focus, and it registers that listener in an effect — so a sender
 * that gives the conversation the focus and dispatches on the very next
 * frame is guessing about when React gets round to the effect. Twice that
 * guess was wrong and the marks went nowhere while a notice said they had
 * been sent. So the hand-over asks for a receipt: the event carries
 * `onReceived`, the composer calls it, and the sender dispatches again each
 * frame until it is called or it gives up — and then it *knows*.
 */

export interface ComposeAttachment {
  readonly name: string
  readonly path: string
  readonly kind: 'image' | 'note'
  /** Note chips only: the block the chip carries. */
  readonly text?: string
}

export interface ComposeRequest {
  readonly text: string
  readonly replace?: boolean
  readonly attachments?: readonly ComposeAttachment[]
}

/** How many frames a composer gets to turn up before the hand-over is reported as lost. */
export const HAND_OVER_FRAMES = 30

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

/**
 * Dispatches the request until a composer acknowledges it. Resolves `true`
 * on receipt, `false` when nobody was listening for `frames` frames.
 */
export const handOverToComposer = async (request: ComposeRequest, { frames = HAND_OVER_FRAMES } = {}): Promise<boolean> => {
  let received = false
  const detail = { ...request, onReceived: () => { received = true } }
  for (let attempt = 0; attempt < frames && !received; attempt += 1) {
    window.dispatchEvent(new CustomEvent('harnessdesk:compose', { detail }))
    if (received) break
    await nextFrame()
  }
  return received
}

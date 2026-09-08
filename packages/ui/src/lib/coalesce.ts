/**
 * Runs `fn` at most once per animation frame, however often it is asked.
 *
 * Several conversations streaming at once produce hundreds of events a
 * second, and each used to wake every subscriber. The store's snapshot is
 * updated on every event — nothing is lost — but subscribers are told once
 * per frame, which is as often as a screen can show the difference.
 *
 * Delivery is guaranteed, not merely frame-aligned: browsers suspend
 * `requestAnimationFrame` for hidden windows, and a wake that waits for a
 * frame that never comes is a wake that never happens — a minimized window
 * would freeze `connect()` mid-handshake. The timer is the floor; the frame,
 * when one arrives first, keeps updates aligned with painting.
 */
export const coalesce = (fn: () => void): (() => void) => {
  let scheduled = false
  const run = (): void => {
    if (!scheduled) return
    scheduled = false
    fn()
  }
  return () => {
    if (scheduled) return
    scheduled = true
    const timer = setTimeout(run, 32)
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        clearTimeout(timer)
        run()
      })
    }
  }
}

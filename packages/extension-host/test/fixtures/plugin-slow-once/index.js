import { existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * A plugin whose first load wedges the child, and whose every later load is
 * instant: a host that starts late once and fine after.
 *
 * The first load leaves a marker beside the plugin and then holds the event
 * loop far past any test's deadline, so the caller gives up and the child is
 * killed. The child the supervisor then restarts finds the marker and loads
 * at once, which is the point: what it brings up is healthy, and so it stays
 * up for as long as nobody disposes the host.
 */
const marker = fileURLToPath(new URL('./loaded-once', import.meta.url))

export const plugin = {
  name: 'slow-once',
  inject: [],
  apply() {
    if (existsSync(marker)) return
    writeFileSync(marker, '')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000)
  },
}

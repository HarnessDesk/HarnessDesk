import { ExtensionKernel } from '@harnessdesk/cordis-host'

import { SupervisedExtensionHost, type SupervisedExtensionHostOptions } from '../src/index.js'

/**
 * The plugin hosts a test file starts, accounted for before the file ends.
 *
 * A host owns a child process, and a child process nobody disposed is the one
 * failure a test run cannot report. Its handle keeps the file's process up
 * after every test has finished, `--test-timeout` ends a test and not the
 * process around it (measured on Node 25), and the runner prints its summary
 * and the detail of every failure only once all its files' processes have
 * exited. So the gate sat on a file whose tests were over, with nothing left
 * to read, until somebody killed it by hand (#1306).
 *
 * A file therefore starts its hosts through `hosts.make` and ends with
 * `after(() => hosts.settle())`. The supervisor restarts a child that dies on
 * its own, which is why a start that failed is not a start that left nothing
 * running: whoever called it must still dispose the host.
 */

/** A plugin host that remembers whether it was disposed, and what it was for. */
export class TrackedHost extends SupervisedExtensionHost {
  /** Whether `dispose` has been asked for, by its test or by the sweep at the end of the file. */
  disposed = false

  constructor(
    readonly label: string,
    options: SupervisedExtensionHostOptions = {},
  ) {
    super(new ExtensionKernel(), options)
  }

  override async dispose(): Promise<void> {
    this.disposed = true
    await super.dispose()
  }
}

/** Every host one test file starts. */
export class Hosts {
  readonly #made: TrackedHost[] = []

  /** A host this file will have to account for. `label` is what a failure calls it. */
  make(label: string, options: SupervisedExtensionHostOptions = {}): TrackedHost {
    const host = new TrackedHost(label, options)
    this.#made.push(host)
    return host
  }

  /**
   * The end of a file. Arms `failIfStillOpen`, disposes every host that is
   * still up so the file can exit, and then fails naming those no test had
   * disposed — the test that left one running is the one to fix.
   */
  async settle(): Promise<void> {
    failIfStillOpen()
    const left = this.#made.filter((host) => !host.disposed)
    await Promise.all(left.map((host) => host.dispose()))
    if (left.length > 0) {
      throw new Error(
        `A test left its plugin host running; its child process would have held this file open: ` +
          left.map((host) => host.label).join(', '),
      )
    }
  }
}

/**
 * How many child processes this process has started and not yet let go of.
 *
 * Read it as "has this reached zero", not as a single sample: the handle of a
 * child that has exited is closed a turn after its `exit` event, so a count
 * taken in between still includes it.
 */
export const childrenUp = (): number =>
  process.getActiveResourcesInfo().filter((name) => name === 'ProcessWrap').length

/** Resolves once every child this process started has gone; rejects, saying how many are not, if that takes too long. */
export const childrenGone = async (timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (childrenUp() > 0) {
    if (Date.now() > deadline) throw new Error(`${childrenUp()} child process(es) still up after ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/**
 * Ends this process, with a message, if it is still running `afterMs` from now.
 *
 * Armed when a file's last test is done. A process with nothing left to run
 * that cannot exit is held open by something a test started and did not
 * close, and the runner waits on it for as long as it is left. This names the
 * handles and exits non-zero, which the runner reports as that file failing.
 * The default is well past what disposing a host takes, which gives up on a
 * child after two seconds.
 *
 * The timer is unref'd: a file that does exit is not kept waiting for it.
 */
export const failIfStillOpen = (afterMs = 15_000): void => {
  setTimeout(() => {
    const open = new Map<string, number>()
    for (const name of process.getActiveResourcesInfo()) open.set(name, (open.get(name) ?? 0) + 1)
    const held = [...open].map(([name, count]) => (count > 1 ? `${name} x${count}` : name)).join(', ')
    const waited = afterMs >= 1000 ? `${Math.round(afterMs / 1000)}s` : `${afterMs}ms`
    process.stderr.write(
      `This process is still running ${waited} after its last test; held open by: ${held}. ` +
        'A child process or handle a test started was never closed.\n',
    )
    process.exit(1)
  }, afterMs).unref()
}

import type { TestContext } from 'node:test'
import { createServer, type AddressInfo, type Socket } from 'node:net'

/**
 * The rig every test in this directory asks its questions through.
 *
 * A bridge's family cannot be watched from the outside without guessing: the
 * two questions — is it up, is it gone — used to be a sleep and a polled
 * `kill(pid, 0)` against a wall-clock budget, which read a slow start as a
 * bridge that never launched one and a slow death as a leak. Both are events
 * the kernel delivers, if the stand-ins are made to hold something the kernel
 * closes for them.
 */

/** One stand-in process that has checked in on the lifeline. */
export interface Checkin {
  /** Whether it is still holding the line. Asked before anything is signalled:
   *  a stand-in that had already fallen over on its own would let every
   *  assertion below pass without a reap having happened at all. */
  alive(): boolean
  /** Resolves when its end of the line closes, which is when it dies. */
  readonly gone: Promise<void>
}

export interface Lifeline {
  readonly port: number
  /** The next process to check in — awaited if it has not arrived yet. */
  checkin(): Promise<Checkin>
}

/**
 * A loopback server every stand-in connects to and then never speaks on
 * again, so the connection *is* the process.
 *
 * That turns both questions into events the kernel delivers. "It is up" is the
 * accept; "it is gone" is the close, because a socket's end is closed by the
 * kernel whichever way its owner left — SIGKILL included. What this replaces
 * polled `kill(pid, 0)` against a wall-clock budget and asked whether the
 * answer had arrived yet: under the whole suite at once a loaded machine read
 * a slow death as a leak, and a `kill(pid, 0)` that catches a not-yet-reaped
 * zombie says "alive" of a process that is not.
 */
export const lifeline = async (t: TestContext): Promise<Lifeline> => {
  const arrived: Checkin[] = []
  const waiting: Array<(checkin: Checkin) => void> = []
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    /* A process killed outright resets its connection rather than closing it.
       That reset is the event being waited for and not a failure — but an
       unheard 'error' on a socket is still a thrown exception. */
    socket.on('error', () => {})
    let holding = true
    const checkin: Checkin = {
      alive: () => holding,
      gone: new Promise<void>((resolve) => {
        socket.on('close', () => {
          holding = false
          sockets.delete(socket)
          resolve()
        })
      }),
    }
    const next = waiting.shift()
    if (next) next(checkin)
    else arrived.push(checkin)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    // Anything still connected has to be let go of first: `close()` stops new
    // arrivals and then waits for the ones already in.
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return {
    port: (server.address() as AddressInfo).port,
    checkin: async () => arrived.shift() ?? new Promise<Checkin>((resolve) => waiting.push(resolve)),
  }
}

/**
 * Check in, and hold the line for as long as this process lives. Written
 * after the signal handlers in every stand-in, so that a check-in the test
 * can see means the handlers are already installed.
 */
export const checkIn = (port: number, andThen = ''): string => `
    import { connect } from 'node:net'
    connect(${port}, '127.0.0.1', () => {${andThen}}).on('error', () => {})
`

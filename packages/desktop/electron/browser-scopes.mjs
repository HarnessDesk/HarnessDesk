import { answered } from './deadline.mjs'
import { printOptions, printResult } from './pdf.mjs'

const profileKey = (profile) => profile ?? 'default'

export function browserPartition(profile, keep) {
  if (profile === null) return keep ? 'persist:harnessdesk-browser' : 'harnessdesk-browser-once'
  if (
    typeof profile !== 'string' ||
    !/^lane-[A-Za-z0-9-]{1,100}$/.test(profile) ||
    profile.endsWith('\n')
  ) {
    throw new Error('The host did not name a lane browser profile.')
  }
  return `persist:hd-${profile}`
}

/** Dependency injection keeps the tests on the actual engine, without an Electron process. */
export function createProfileBrowserEngine({
  ipc,
  contents,
  sessionForPartition,
  window: currentWindow,
  show,
  allowedProfile,
  keep = () => true,
  readyTimeoutMs = 10_000,
}) {
  const guests = new Map()
  const known = new Map()
  const waiters = new Map()
  const focused = new Map()
  const banked = new WeakMap()
  const partitionProfiles = new Map()
  const attaching = new WeakMap()
  let nextRequest = 0
  let tail = Promise.resolve()
  const serial = (body) => {
    const work = tail.then(body, body)
    tail = work.catch(() => {})
    return work
  }
  const deskSender = (event) => event.sender === currentWindow()?.webContents
  const partition = (profile) => {
    const value = browserPartition(profile, keep())
    if (profile !== null && !allowedProfile(profile)) {
      throw new Error('This browser profile is not owned by a kept lane.')
    }
    partitionProfiles.set(sessionForPartition(value), profile)
    return value
  }
  const pending = (map, key, message) => {
    let entry = map.get(key)
    if (entry) return entry.promise
    let resolve
    let reject
    const promise = new Promise((yes, no) => {
      resolve = yes
      reject = no
    })
    const timer = setTimeout(() => {
      map.delete(key)
      reject(new Error(message))
    }, readyTimeoutMs)
    entry = {
      promise,
      resolve: (value) => {
        clearTimeout(timer)
        map.delete(key)
        resolve(value)
      },
      reject: (error) => {
        clearTimeout(timer)
        map.delete(key)
        reject(error)
      },
    }
    map.set(key, entry)
    promise.catch(() => {})
    return promise
  }
  const assertGuest = (profile, wc) => {
    partition(profile)
    if (
      !wc ||
      wc.isDestroyed() ||
      wc.getType() !== 'webview' ||
      wc.hostWebContents !== currentWindow()?.webContents ||
      !(profile === null
        ? ['persist:harnessdesk-browser', 'harnessdesk-browser-once'].some(
            (key) => wc.session === sessionForPartition(key),
          )
        : wc.session === sessionForPartition(partition(profile)))
    ) {
      throw new Error('That page is not open in this browser profile.')
    }
  }
  ipc.on('harnessdesk:browser-ready', (event, request) => {
    if (!deskSender(event)) return
    const profile = request?.profile
    try {
      const wc = Number.isInteger(request?.webContentsId)
        ? contents.fromId(request.webContentsId)
        : null
      assertGuest(profile, wc)
      const key = profileKey(profile)
      guests.set(key, wc)
      if (!known.has(wc.id)) {
        known.set(wc.id, profile)
        wc.once('destroyed', () => {
          known.delete(wc.id)
          if (guests.get(key) === wc) guests.delete(key)
        })
      } else if (known.get(wc.id) !== profile) {
        return
      }
      waiters.get(key)?.resolve(wc)
    } catch {
      // Refuse malformed, foreign and unauthorized guest announcements.
    }
  })
  ipc.on('harnessdesk:browser-gone', (event, request) => {
    if (!deskSender(event)) return
    const key = profileKey(request?.profile)
    if (guests.get(key)?.id === request?.webContentsId) guests.delete(key)
  })
  ipc.on('harnessdesk:browser-focused', (event, request) => {
    if (!deskSender(event)) return
    focused.get(request?.request)?.resolve(null)
  })
  const front = async (profile) => {
    const window = currentWindow()
    if (!window || window.isDestroyed()) throw new Error('The browser window is closed.')
    const request = ++nextRequest
    const ready = pending(focused, request, 'The browser profile did not become visible in time.')
    try {
      window.webContents.send('harnessdesk:browser-focus', { profile, request })
    } catch (error) {
      focused.get(request)?.reject(error)
    }
    await ready
  }
  const attach = async (wc) => {
    let work = attaching.get(wc)
    if (work) return work
    work = (async () => {
      if (wc.debugger.isAttached()) return
      wc.debugger.attach('1.3')
      const events = []
      banked.set(wc, events)
      wc.debugger.on('message', (_event, method, params) => {
        events.push({ method, params: params ?? {} })
        if (events.length > 3000) events.splice(0, events.length - 3000)
      })
      await answered('Page.enable', wc.debugger.sendCommand('Page.enable'))
      await answered('Runtime.enable', wc.debugger.sendCommand('Runtime.enable'))
      for (const domain of ['Log.enable', 'Network.enable']) {
        try {
          await answered(domain, wc.debugger.sendCommand(domain))
        } catch {
          // Optional domain.
        }
      }
    })()
    attaching.set(wc, work)
    try {
      await work
    } finally {
      attaching.delete(wc)
    }
  }
  const senderFor = async (profile, wc) => {
    assertGuest(profile, wc)
    await attach(wc)
    return {
      send: (method, params) =>
        serial(async () => {
          assertGuest(profile, wc)
          await front(profile)
          assertGuest(profile, wc)
          if (method.startsWith('Input.')) wc.focus()
          if (method === 'Page.printToPDF') {
            return printResult(
              await answered(method, wc.printToPDF(printOptions(params ?? {}))),
            )
          }
          return answered(method, wc.debugger.sendCommand(method, params ?? {}))
        }),
      drain: async () => {
        assertGuest(profile, wc)
        return (banked.get(wc) ?? []).splice(0)
      },
    }
  }
  return {
    partition,
    profileForPartition(value) {
      if (value === 'persist:harnessdesk-browser' || value === 'harnessdesk-browser-once') {
        partitionProfiles.set(sessionForPartition(value), null)
        return null
      }
      if (typeof value !== 'string' || !value.startsWith('persist:hd-')) return undefined
      const profile = value.slice('persist:hd-'.length)
      try {
        return partition(profile) === value ? profile : undefined
      } catch {
        return undefined
      }
    },
    profileOfSession(value) {
      return partitionProfiles.get(value)
    },
    profileOf(id) {
      return known.has(id) ? known.get(id) : undefined
    },
    knows(id) {
      return known.has(id) && !contents.fromId(id)?.isDestroyed()
    },
    async capture(id) {
      if (!known.has(id)) throw new Error('That page is no longer open.')
      const sender = await senderFor(known.get(id), contents.fromId(id))
      const shot = await sender.send('Page.captureScreenshot', { format: 'png' })
      return Buffer.from(shot.data, 'base64')
    },
    async ensure(identity) {
      const profile = identity && identity.profile !== 'default' ? identity.profile : null
      partition(profile)
      const key = profileKey(profile)
      let wc = guests.get(key)
      if (!wc || wc.isDestroyed()) {
        const window = (await show()) ?? currentWindow()
        if (!window) throw new Error('HarnessDesk has no window to show a browser in.')
        const ready = pending(waiters, key, 'The browser pane did not open in time.')
        try {
          window.webContents.send('harnessdesk:browser-show', { profile, url: 'about:blank' })
        } catch (error) {
          waiters.get(key)?.reject(error)
        }
        wc = await ready
      }
      return senderFor(profile, wc)
    },
    async close(identity) {
      const profile = identity && identity.profile !== 'default' ? identity.profile : null
      partition(profile)
      const key = profileKey(profile)
      const wc = guests.get(key)
      if (wc && !wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
      guests.delete(key)
      waiters.get(key)?.reject(new Error('This browser profile was closed.'))
      currentWindow()?.webContents.send('harnessdesk:browser-close', { profile })
    },
  }
}

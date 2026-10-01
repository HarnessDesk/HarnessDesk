import { describe, expect, it } from 'vitest'

import { browserLoadFailureMessage } from './browser-load-error'

describe('browserLoadFailureMessage', () => {
  it('turns common network errors into a plain sentence naming the host and cause', () => {
    expect(browserLoadFailureMessage('http://127.0.0.1:9/', -102))
      .toBe("Couldn't reach 127.0.0.1 — the connection was refused")
    expect(browserLoadFailureMessage('https://missing.example/', -105))
      .toBe("Couldn't reach missing.example — the address was not found")
    expect(browserLoadFailureMessage('https://slow.example/', -7))
      .toBe('Loading slow.example timed out')
    expect(browserLoadFailureMessage('https://secure.example/', -202))
      .toBe("Couldn't load secure.example — the certificate was rejected")
  })

  it('includes the code when Chromium reports an unknown failure', () => {
    expect(browserLoadFailureMessage('http://127.0.0.1:9/', -999))
      .toBe("Couldn't load 127.0.0.1 — error -999")
  })
})

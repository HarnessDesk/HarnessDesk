import { describe, expect, it } from 'vitest'

import { runtimeId } from '@harnessdesk/protocol'

import { dashboardRouteFor } from './App'

/**
 * Where every Dashboard entry point lands.
 *
 * ⌘U, the sidebar's own Dashboard row, ⌘K and the menu bar item all call this
 * with no runtime — the rail used to hold one row per account, and now
 * anything that used to open across every one of them opens on Overview
 * instead. An account's own "Usage" verb, and a fix routed to `usage`, name a
 * runtime — the account that needs looking at — and land on Plans, scoped to
 * it, the way clicking that account in the old rail used to.
 */
describe('dashboardRouteFor', () => {
  it('opens on Overview, across every account, with no runtime named', () => {
    expect(dashboardRouteFor()).toEqual({ view: 'overview', scope: null })
  })

  it('opens on Plans, scoped, when an account is named', () => {
    const codex = runtimeId('codex')
    expect(dashboardRouteFor(codex)).toEqual({ view: 'plans', scope: codex })
  })
})

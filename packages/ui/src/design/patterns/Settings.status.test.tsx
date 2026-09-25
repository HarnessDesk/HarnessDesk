import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CheckIcon } from '../../components/Icons'
import {
  AccessCode,
  AccessDetail,
  AccessFact,
  AccessRail,
  AccessRailFooter,
  AccessRailHeader,
  AccessRailList,
  StateStrip,
  StatusSummary,
} from './Settings'

describe('access status roles', () => {
  it('names every segment and exposes one status-summary anatomy', () => {
    const markup = renderToStaticMarkup(
      <>
        <StateStrip states={['ready', 'signin', 'limit', 'broken']} />
        <StatusSummary
          tone="success"
          icon={<CheckIcon />}
          title="Connected"
          description="The account is ready."
        />
      </>,
    )

    expect(markup).toContain('data-slot="state-strip"')
    expect(markup).toContain('aria-label="4 agents: 1 ready, 1 needs sign-in, 1 at a limit, 1 unavailable"')
    expect(markup).toContain('data-slot="status-summary"')
    expect(markup).toContain('data-tone="success"')
    expect(markup).toContain('data-slot="status-summary-title"')
    expect(markup).toContain('data-slot="status-summary-description"')
  })

  it('names the access sheet regions and preserves verbatim values', () => {
    const markup = renderToStaticMarkup(
      <>
        <AccessRail aria-label="Agents">
          <AccessRailHeader>Your agents</AccessRailHeader>
          <AccessRailList>Agent rows</AccessRailList>
          <AccessRailFooter>Local credentials</AccessRailFooter>
        </AccessRail>
        <AccessDetail>
          <AccessFact label="Credential" value="~/.agent">Kept on this machine.</AccessFact>
          <AccessCode>ABCD-EFGH</AccessCode>
        </AccessDetail>
      </>,
    )

    for (const slot of ['access-rail', 'access-rail-header', 'access-rail-list', 'access-rail-footer', 'access-detail', 'access-fact', 'access-code']) {
      expect(markup).toContain(`data-slot="${slot}"`)
    }
    expect(markup).toContain('<code')
    expect(markup).toContain('~/.agent')
  })
})

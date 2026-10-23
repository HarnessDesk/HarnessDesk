import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { GeneralSection } from './SettingsYou'

it('describes local data without claiming a fixed home folder', () => {
 const markup=renderToStaticMarkup(<GeneralSection rows={null}/>)
 expect(markup).toContain('preferences, conversations and work records on this Mac')
 expect(markup).not.toContain('~/.harnessdesk')
})

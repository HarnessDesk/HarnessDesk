import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { GeneralSection } from './SettingsYou'

it('describes local data without claiming a fixed home folder', () => {
 const markup=renderToStaticMarkup(<StoreProvider store={{getSnapshot: emptySnapshot, subscribe: () => () => {}} as unknown as AppStore}><GeneralSection rows={null}/></StoreProvider>)
 expect(markup).toContain('preferences, conversations and work records on this Mac')
 expect(markup).not.toContain('~/.harnessdesk')
})

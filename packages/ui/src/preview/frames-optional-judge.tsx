import { useMemo } from 'react'
import { RaceStart } from '../components/RaceStart'
import { StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { teamStartStore } from './frames-team-start'

const RaceFrame = () => {
  useTheme()
  return <RaceStart root="/work/storefront" task="Fix the cart total" onClose={() => {}} />
}

/** /race uses the same synthetic project and New Team form. */
export const OptionalJudgeFrame = () => {
  const store = useMemo(teamStartStore, [])
  return <StoreProvider store={store}><RaceFrame /></StoreProvider>
}

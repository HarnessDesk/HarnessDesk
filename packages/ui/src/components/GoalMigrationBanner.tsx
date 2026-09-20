import { Banner, BannerAction } from '../design'
import { useSnapshot, useStore } from '../state/context'

export const GoalMigrationBanner = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  if (!snapshot.goalMigrationPending) return null
  return (
    <Banner
      tone="info"
      title="Rooms are now Goals"
      actions={<BannerAction onClick={() => void store.ackGoalMigration()}>Got it</BannerAction>}
    >
      Your rooms, boards and members were kept. Goal Seats now define active membership.
    </Banner>
  )
}

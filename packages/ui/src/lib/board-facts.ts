/*
 * Where a card sits on the board, and why — the protocol's own rule, not a
 * copy of it. The Goal's activity, which its header and the sidebar read, is
 * computed on the host from these same placements; a second copy here is how
 * a board said "0 need you" under a header that said "Needs you".
 */
export {
  FACT_COLUMNS,
  flowRoleOf,
  flowStepOf,
  placeCard,
  type FactColumn,
  type FlowStep,
  type PlaceInput,
  type Placement,
} from '@harnessdesk/protocol'

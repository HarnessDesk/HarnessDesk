import { createContext, useContext, type ReactNode } from 'react'
import type { HostTimeInterval } from '../lib/host-clock'

// Undefined leaves isolated design specimens on their explicitly supplied clock.
const HostTimeContext = createContext<HostTimeInterval | null | undefined>(undefined)
export const HostTimeProvider = ({ interval, children }: { interval: HostTimeInterval | null; children: ReactNode }) =>
  <HostTimeContext.Provider value={interval}>{children}</HostTimeContext.Provider>
export const useHostTime = () => useContext(HostTimeContext)

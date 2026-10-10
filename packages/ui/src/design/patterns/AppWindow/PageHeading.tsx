import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'

export interface PageHeadingData { readonly place: ReactNode; readonly actions?: ReactNode }
interface Channel {
  readonly claim: (token: object) => void
  readonly publish: (token: object, data: PageHeadingData) => void
  readonly remove: (token: object) => void
}
const Heading = createContext<Channel | null>(null)
export const PageHeadingProvider = ({ children, onHeading }: {
  children: ReactNode; onHeading: (heading: PageHeadingData | null) => void
}) => {
  const receive = useRef(onHeading)
  receive.current = onHeading
  const channel = useMemo<Channel>(() => {
    let current: object | null = null, last: PageHeadingData | null = null
    return {
      claim: token => { current = token },
      publish: (token, data) => {
        if (current !== token || (last?.place === data.place && last?.actions === data.actions)) return
        last = data; receive.current(data)
      },
      remove: token => {
        if (current !== token) return
        current = null; last = null; receive.current(null)
      },
    }
  }, [])
  return <Heading.Provider value={channel}>{children}</Heading.Provider>
}
export const usePageHeading = (place: ReactNode, actions?: ReactNode): boolean => {
  const channel = useContext(Heading), token = useRef<object>({})
  useLayoutEffect(() => {
    const identity = token.current
    channel?.claim(identity)
    return () => channel?.remove(identity)
  }, [channel])
  useLayoutEffect(() => { channel?.publish(token.current, { place, actions }) }, [channel, place, actions])
  return channel !== null
}

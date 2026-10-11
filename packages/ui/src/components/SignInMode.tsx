import { createContext } from 'react'
export const SignInMode = createContext<'modal' | 'embedded'>('modal')

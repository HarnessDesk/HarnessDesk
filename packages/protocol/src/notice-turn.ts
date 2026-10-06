import type { Turn } from './session.js'

/** Identifies a host-created turn that holds conversation notices before real turns arrive. */
export const isNoticeTurn = (turn: Turn): boolean => String(turn.id).startsWith('notice:')

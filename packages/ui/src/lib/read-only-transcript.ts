import { createContext } from 'react'

/**
 * True below a transcript drawn as a read-only copy: nothing in it may open,
 * answer or act. Its own module, so a part of the transcript drawn elsewhere
 * too (the sub-agent card) can read it without importing the transcript.
 */
export const ReadOnlyTranscriptContext = createContext(false)

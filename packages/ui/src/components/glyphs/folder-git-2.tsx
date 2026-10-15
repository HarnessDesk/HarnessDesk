// Vendored from lucide-animated (`folder-git-2`); ./index.ts says what changed.

import { motion } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const DURATION = 0.3

const CALCULATE_DELAY = (i: number) => {
  if (i === 0) return 0.1

  return i * DURATION + 0.1
}

export const FolderGit2Glyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="folder-git-2" {...props}>
    <path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5" />
    <motion.circle
      animate={controls}
      cx="13"
      cy="12"
      r="2"
      transition={{
        duration: DURATION,
        delay: CALCULATE_DELAY(0),
        opacity: { delay: CALCULATE_DELAY(0) },
      }}
      variants={{
        normal: { pathLength: 1, opacity: 1, transition: { delay: 0 } },
        animate: {
          pathLength: [0, 1],
          opacity: [0, 1],
        },
      }}
    />
    <motion.path
      animate={controls}
      d="M18 19c-2.8 0-5-2.2-5-5v8"
      transition={{
        duration: DURATION,
        delay: CALCULATE_DELAY(1),
        opacity: { delay: CALCULATE_DELAY(1) },
      }}
      variants={{
        normal: {
          pathLength: 1,
          pathOffset: 0,
          opacity: 1,
          transition: { delay: 0 },
        },
        animate: {
          pathLength: [0, 1],
          opacity: [0, 1],
          pathOffset: [1, 0],
        },
      }}
    />
    <motion.circle
      animate={controls}
      cx="20"
      cy="19"
      r="2"
      transition={{
        duration: DURATION,
        delay: CALCULATE_DELAY(2),
        opacity: { delay: CALCULATE_DELAY(2) },
      }}
      variants={{
        normal: { pathLength: 1, opacity: 1, transition: { delay: 0 } },
        animate: {
          pathLength: [0, 1],
          opacity: [0, 1],
        },
      }}
    />
  </Glyph>
)

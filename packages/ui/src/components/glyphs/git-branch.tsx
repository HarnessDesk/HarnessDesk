// Vendored from lucide-animated (`git-branch`); ./index.ts says what changed.

import { motion } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const DURATION = 0.3

const CALCULATE_DELAY = (i: number) => {
  if (i === 0) return 0.1

  return i * DURATION + 0.1
}

export const GitBranchGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="git-branch" {...props}>
    <motion.circle
      animate={controls}
      cx="18"
      cy="6"
      r="3"
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

    <motion.line
      animate={controls}
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
      x1="6"
      x2="6"
      y1="3"
      y2="15"
    />

    <motion.circle
      animate={controls}
      cx="6"
      cy="18"
      r="3"
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

    <motion.path
      animate={controls}
      d="M18 9a9 9 0 0 1-9 9"
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
  </Glyph>
)

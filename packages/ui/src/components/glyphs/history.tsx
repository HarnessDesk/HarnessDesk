// Vendored from lucide-animated (`history`); ./index.ts says what changed.

import { motion, type Transition, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const ARROW_TRANSITION: Transition = {
  type: 'spring',
  stiffness: 250,
  damping: 25,
}

const ARROW_VARIANTS: Variants = {
  normal: {
    rotate: '0deg',
  },
  animate: {
    rotate: '-50deg',
  },
}

const HAND_TRANSITION: Transition = {
  duration: 0.6,
  ease: [0.4, 0, 0.2, 1],
}

const HAND_VARIANTS: Variants = {
  normal: {
    rotate: 0,
    originX: '0%',
    originY: '100%',
  },
  animate: {
    rotate: -360,
    originX: '0%',
    originY: '100%',
  },
}

const MINUTE_HAND_TRANSITION: Transition = {
  duration: 0.5,
  ease: 'easeInOut',
}

const MINUTE_HAND_VARIANTS: Variants = {
  normal: {
    rotate: 0,
    originX: '0%',
    originY: '0%',
  },
  animate: {
    rotate: -45,
    originX: '0%',
    originY: '0%',
  },
}

export const HistoryGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="history" {...props}>
    <motion.g
      animate={controls}
      transition={ARROW_TRANSITION}
      variants={ARROW_VARIANTS}
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </motion.g>
    <motion.line
      animate={controls}
      initial="normal"
      transition={HAND_TRANSITION}
      variants={HAND_VARIANTS}
      x1="12"
      x2="12"
      y1="12"
      y2="7"
    />
    <motion.line
      animate={controls}
      initial="normal"
      transition={MINUTE_HAND_TRANSITION}
      variants={MINUTE_HAND_VARIANTS}
      x1="12"
      x2="16"
      y1="12"
      y2="14"
    />
  </Glyph>
)

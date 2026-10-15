// Vendored from lucide-animated (`workflow`); ./index.ts says what changed.

import { motion, type Transition, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const TRANSITION: Transition = {
  duration: 0.3,
  opacity: { delay: 0.15 },
}

const VARIANTS: Variants = {
  normal: {
    pathLength: 1,
    opacity: 1,
  },
  animate: (custom: number) => ({
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: {
      ...TRANSITION,
      delay: 0.1 * custom,
    },
  }),
}

export const WorkflowGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="workflow" {...props}>
    <motion.rect
      animate={controls}
      custom={0}
      height="8"
      rx="2"
      variants={VARIANTS}
      width="8"
      x="3"
      y="3"
    />
    <motion.path
      animate={controls}
      custom={3}
      d="M7 11v4a2 2 0 0 0 2 2h4"
      variants={VARIANTS}
    />
    <motion.rect
      animate={controls}
      custom={0}
      height="8"
      rx="2"
      variants={VARIANTS}
      width="8"
      x="13"
      y="13"
    />
  </Glyph>
)

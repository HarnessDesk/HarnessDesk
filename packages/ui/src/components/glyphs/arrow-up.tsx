// Vendored from lucide-animated (`arrow-up`); ./index.ts says what changed.

import { motion, type Variants } from 'motion/react'

import { Glyph, type GlyphProps } from './glyph'

const PATH_VARIANTS: Variants = {
  normal: { d: 'm5 12 7-7 7 7', translateY: 0 },
  animate: {
    d: 'm5 12 7-7 7 7',
    translateY: [0, 3, 0],
    transition: {
      duration: 0.4,
    },
  },
}

const SECOND_PATH_VARIANTS: Variants = {
  normal: { d: 'M12 19V5' },
  animate: {
    d: ['M12 19V5', 'M12 19V10', 'M12 19V5'],
    transition: {
      duration: 0.4,
    },
  },
}

export const ArrowUpGlyph = ({ controls, ...props }: GlyphProps) => (
  <Glyph name="arrow-up" {...props}>
    <motion.path
      animate={controls}
      d="m5 12 7-7 7 7"
      variants={PATH_VARIANTS}
    />
    <motion.path
      animate={controls}
      d="M12 19V5"
      variants={SECOND_PATH_VARIANTS}
    />
  </Glyph>
)

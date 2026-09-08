import { Tabs as TabsPrimitive } from '@base-ui/react/tabs'
import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Vendored from shadcn/ui — the **Base UI** tabs, not the Radix ones.
 *
 * The registry ships three builds of this component and they are not
 * interchangeable: parts are named differently (`Tab`/`Panel`, not
 * `Trigger`/`Content`), and the selected state arrives as `data-active`
 * rather than `data-[state=active]`. A file half-migrated between them
 * compiles and renders an unstyled tab, so the import at the top of this file
 * is the thing to read first.
 *
 * Two reasons this build is the one the app is on, beyond the user's choice:
 *
 *   `variant="line"` exists.   The desk's own tab strips — the browser's, the
 *                              terminal's, the review pane's — were all
 *                              underline tabs hand-rolled three times over.
 *                              The Radix build has no such variant, which is
 *                              most of why they were hand-rolled.
 *   Vertical is a prop.        `orientation="vertical"` moves the indicator to
 *                              the inline edge and turns the list into a
 *                              column, rather than being a second component.
 *
 * The local departures every file in this folder shares (see index.ts) apply:
 * heights come from `--hd-` measure tokens, and the ring utilities are dropped
 * because app.css already draws the desk's one `:focus-visible` outline.
 */

const Tabs = ({
  className,
  orientation = 'horizontal',
  ...props
}: TabsPrimitive.Root.Props) => (
  <TabsPrimitive.Root
    data-slot="tabs"
    orientation={orientation}
    /*
     * `group/tabs` is how the list and the tabs below read the orientation
     * without being told it a second time — the root is the only place it is
     * declared.
     *
     * The selector is `data-[orientation=…]`, and that is a deliberate
     * departure from the snippet the registry publishes, which writes
     * `data-horizontal:`. Base UI 1.7 emits `data-orientation="horizontal"`
     * and no `data-horizontal` attribute at all, so the published class never
     * matches: the root stays `flex-row`, and a horizontal tab strip renders
     * beside its panel instead of above it. Verified against the live DOM
     * rather than the docs — `data-active` on the tab is real, this one was
     * not. Re-check it if these are ever re-vendored.
     */
    className={cn(
      'group/tabs flex gap-2 data-[orientation=horizontal]:flex-col',
      className,
    )}
    {...props}
  />
)

const tabsListVariants = cva(
  'group/tabs-list inline-flex w-fit items-center justify-center text-(--hd-muted-foreground) group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col',
  {
    variants: {
      variant: {
        /* The enclosed control: a filled track with the active tab lifted out
           of it. Reads as one object, so it belongs where it sits *beside*
           things — a card header, a toolbar. */
        default:
          'rounded-(--hd-radius-sm) bg-(--hd-muted) p-0.5 group-data-[orientation=horizontal]/tabs:h-(--hd-control-h)',
        /* The underline: no track, an indicator under the active tab. Belongs
           where the tabs sit *above* what they switch — a pane, a page — and
           the rule under them is shared with the content's own top edge. */
        line: 'gap-1 rounded-none bg-transparent group-data-[orientation=horizontal]/tabs:h-(--hd-control-h)',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

const TabsList = ({
  className,
  variant = 'default',
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) => (
  <TabsPrimitive.List
    data-slot="tabs-list"
    data-variant={variant}
    className={cn(tabsListVariants({ variant }), className)}
    {...props}
  />
)

const TabsTrigger = ({ className, ...props }: TabsPrimitive.Tab.Props) => (
  <TabsPrimitive.Tab
    data-slot="tabs-trigger"
    className={cn(
      'relative inline-flex items-center justify-center gap-1.5 rounded-(--hd-radius-sm) border border-transparent px-2 text-sm font-medium whitespace-nowrap outline-none transition-colors',
      'text-(--hd-muted-foreground) hover:text-(--hd-foreground)',
      'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
      '[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
      'group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start',
      'group-data-[orientation=horizontal]/tabs:h-[calc(100%-1px)]',
      /* Enclosed: the active tab becomes a raised card on the track. */
      'group-data-[variant=default]/tabs-list:data-active:bg-(--hd-card) group-data-[variant=default]/tabs-list:data-active:text-(--hd-foreground) group-data-[variant=default]/tabs-list:data-active:shadow-(--hd-shadow-sm)',
      /* Line: no fill at all, so the indicator is the only signal. */
      'group-data-[variant=line]/tabs-list:data-active:bg-transparent group-data-[variant=line]/tabs-list:data-active:text-(--hd-foreground)',
      /* The indicator, drawn as an ::after so it costs no layout and cannot
         shift the row when it appears. Only the line variant reveals it. */
      'after:absolute after:bg-(--hd-foreground) after:opacity-0 after:transition-opacity',
      'group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:-bottom-px group-data-[orientation=horizontal]/tabs:after:h-0.5',
      'group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-px group-data-[orientation=vertical]/tabs:after:w-0.5',
      'group-data-[variant=line]/tabs-list:data-active:after:opacity-100',
      className,
    )}
    {...props}
  />
)

const TabsContent = ({ className, ...props }: TabsPrimitive.Panel.Props) => (
  <TabsPrimitive.Panel
    data-slot="tabs-content"
    className={cn('min-w-0 flex-1 outline-none', className)}
    {...props}
  />
)

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }

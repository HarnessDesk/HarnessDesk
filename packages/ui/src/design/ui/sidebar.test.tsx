import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import {
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenu,
} from './sidebar'
import * as sidebarExports from './sidebar'

it('marks only the selected menu row active', () => {
  const markup = renderToStaticMarkup(
    <ul>
      <SidebarMenuItem><SidebarMenuButton label="storefront" isActive /></SidebarMenuItem>
      <SidebarMenuItem><SidebarMenuButton label="atlas-api" /></SidebarMenuItem>
    </ul>,
  )

  expect(markup.match(/data-active="true"/g)).toHaveLength(1)
  expect(markup).not.toContain('data-active="false"')
  expect(markup).toContain('data-[active=true]:bg-(--hd-sidebar-selected)')
})

it('keeps the menu label geometry and the badge/action slot fixed across hover states', () => {
  const rest = renderToStaticMarkup(
    <SidebarMenuItem>
      <SidebarMenuButton label="Fix checkout retry" trailingOverlay />
      <SidebarMenuBadge>2</SidebarMenuBadge>
      <SidebarMenuAction aria-label="More actions" showOnHover>More</SidebarMenuAction>
    </SidebarMenuItem>,
  )
  const hover = renderToStaticMarkup(
    <SidebarMenuItem data-showcase-hover="true">
      <SidebarMenuButton label="Fix checkout retry" trailingOverlay />
      <SidebarMenuBadge>2</SidebarMenuBadge>
      <SidebarMenuAction aria-label="More actions" showOnHover className="opacity-100">More</SidebarMenuAction>
    </SidebarMenuItem>,
  )
  const labelClass = (markup: string) => markup.match(/data-slot="sidebar-menu-label" class="([^"]+)"/)?.[1]
  const slotClass = (markup: string, slot: string) =>
    markup.match(new RegExp(`data-slot="sidebar-menu-${slot}"[^>]*class="([^"]+)"`))?.[1]

  expect(labelClass(rest)).toBe(labelClass(hover))
  expect(labelClass(rest)).toContain('min-w-0')
  expect(labelClass(rest)).toContain('truncate')
  expect(labelClass(rest)).toContain('sidebar-menu-label-fade')
  expect(rest).toContain('text-base')
  expect(slotClass(rest, 'badge')).toContain('sidebar-menu-trailing-slot')
  expect(slotClass(rest, 'action')).toContain('sidebar-menu-trailing-slot')
  // The row's end rail (`--sidebar-menu-end-rail`, derived from `--hd-sidebar-end-rail` in sidebar.css).
  expect(slotClass(rest, 'badge')).toContain('end-(--sidebar-menu-end-rail)')
  expect(slotClass(rest, 'action')).toContain('end-(--sidebar-menu-end-rail)')
  expect(slotClass(rest, 'action')).toContain('bg-sidebar')
  expect(rest).toContain('data-show-on-hover')
  expect(slotClass(rest, 'action')).not.toContain('group-hover/menu-item:opacity-100')
  expect(slotClass(rest, 'action')).not.toContain('group-focus-within/menu-item:opacity-100')
  expect(slotClass(rest, 'action')).toContain('data-[state=open]:opacity-100')
  expect(rest).not.toContain('pe-(--hd-space-8)')
  expect(hover).not.toContain('pe-(--hd-space-8)')
})

it('keeps the mark fixed and assigns the action rail around declared marks', () => {
  const one = renderToStaticMarkup(
    <SidebarMenuItem trailingMarks={1}>
      <SidebarMenuButton label="One action" />
      <SidebarMenuBadge>1</SidebarMenuBadge>
      <SidebarMenuAction showOnHover aria-label="Actions">More</SidebarMenuAction>
    </SidebarMenuItem>,
  )
  const two = renderToStaticMarkup(
    <SidebarMenuItem trailingActions={2} trailingMarks={1}>
      <SidebarMenuButton label="Two actions" trailingActions={2} />
      <SidebarMenuBadge aria-label="Pinned">Pinned</SidebarMenuBadge>
      <SidebarMenuAction showOnHover aria-label="Add">Add</SidebarMenuAction>
      <SidebarMenuAction showOnHover aria-label="Actions">More</SidebarMenuAction>
    </SidebarMenuItem>,
  )

  expect(one).toContain('data-sidebar-trailing-marks="1"')
  expect(two).toContain('data-sidebar-trailing-actions="2"')
  expect(two).toContain('data-sidebar-trailing-marks="1"')
})

it('lets an empty trailing slot use the whole row for its label', () => {
  const markup = renderToStaticMarkup(<SidebarMenuButton label="A long conversation title" />)
  const label = markup.match(/data-slot="sidebar-menu-label" class="([^"]+)"/)?.[1]
  expect(label).not.toContain('sidebar-menu-label-fade')
  expect(markup).not.toContain('pe-(--hd-space-8)')
})

it('reserves the trailing overlay inside label content without shrinking the label box', () => {
  const markup = renderToStaticMarkup(
    <SidebarMenuButton label={<span>Needs you</span>} trailingOverlay labelTrailingContent />,
  )
  const label = markup.match(/data-slot="sidebar-menu-label" class="([^"]+)"/)?.[1]
  const content = markup.match(/data-slot="sidebar-menu-label-content" class="([^"]+)"/)?.[1]
  expect(label).toContain('flex-1')
  expect(label).toContain('sidebar-menu-label-fade')
  expect(label).not.toContain('pe-(--hd-space-8)')
  expect(content).toContain('pe-(--hd-space-8)')
})

it('aligns navigation segments to the sidebar row inset and shares their width', () => {
  const markup = renderToStaticMarkup(<SidebarMenu horizontal><SidebarMenuItem className="flex-1"><button>Agents</button></SidebarMenuItem><SidebarMenuItem className="flex-1"><button>Dashboard</button></SidebarMenuItem><SidebarMenuItem className="flex-1"><button>Plugins</button></SidebarMenuItem></SidebarMenu>)
  expect(markup).toContain('px-(--hd-space-2)')
  expect(markup.match(/flex-1/g)).toHaveLength(3)
})

it('renders the trailing menu action as a named button', () => {
  const markup = renderToStaticMarkup(<SidebarMenuAction aria-label="More actions" />)

  expect(markup).toContain('<button')
  expect(markup).toContain('aria-label="More actions"')
})

it('does not export sidebar parts that duplicate shared controls or workbench layout', () => {
  for (const name of [
    'Sidebar', 'SidebarHeader', 'SidebarContent', 'SidebarFooter',
    'SidebarInput', 'SidebarSeparator', 'SidebarGroupLabel', 'SidebarGroupAction',
    'SidebarMenuSkeleton', 'SidebarMenuSub', 'SidebarMenuSubItem', 'SidebarMenuSubButton',
  ]) {
    expect(sidebarExports).not.toHaveProperty(name)
  }
})

it('shares the nested rail and token indentation between project content and Seat menus', () => {
  const project = renderToStaticMarkup(<sidebarExports.SidebarGroupContent nested><span>Team</span></sidebarExports.SidebarGroupContent>)
  const seats = renderToStaticMarkup(<SidebarMenu nested><SidebarMenuItem>Seat</SidebarMenuItem></SidebarMenu>)
  expect(project).toContain('data-sidebar-indent="true"')
  for (const markup of [project, seats]) {
    expect(markup).toContain('ms-(--hd-space-5)')
    expect(markup).toContain('w-[calc(100%-var(--hd-space-5))]')
    expect(markup).toContain('border-s border-sidebar-border ps-(--hd-space-2)')
  }
})

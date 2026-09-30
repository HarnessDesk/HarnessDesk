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
  expect(slotClass(rest, 'badge')).toContain('end-(--hd-space-1)')
  expect(slotClass(rest, 'action')).toContain('end-(--hd-space-1)')
  expect(slotClass(rest, 'action')).toContain('bg-sidebar')
  expect(slotClass(rest, 'action')).toContain('group-hover/menu-item:opacity-100')
  expect(slotClass(rest, 'action')).toContain('group-focus-within/menu-item:opacity-100')
  expect(slotClass(rest, 'action')).toContain('data-[state=open]:opacity-100')
  expect(rest).not.toContain('pe-(--hd-space-8)')
  expect(hover).not.toContain('pe-(--hd-space-8)')
})

it('lets an empty trailing slot use the whole row for its label', () => {
  const markup = renderToStaticMarkup(<SidebarMenuButton label="A long conversation title" />)
  const label = markup.match(/data-slot="sidebar-menu-label" class="([^"]+)"/)?.[1]
  expect(label).not.toContain('sidebar-menu-label-fade')
  expect(markup).not.toContain('pe-(--hd-space-8)')
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

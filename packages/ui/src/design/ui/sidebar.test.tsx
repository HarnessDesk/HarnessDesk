import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import {
  SidebarGroupAction,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from './sidebar'

it('marks only the selected menu row active', () => {
  const markup = renderToStaticMarkup(
    <ul>
      <SidebarMenuItem><SidebarMenuButton label="storefront" isActive /></SidebarMenuItem>
      <SidebarMenuItem><SidebarMenuButton label="atlas-api" /></SidebarMenuItem>
    </ul>,
  )

  expect(markup.match(/data-active="true"/g)).toHaveLength(1)
  expect(markup.match(/data-active="false"/g)).toHaveLength(1)
  expect(markup).toContain('data-[active=true]:bg-(--hd-sidebar-selected)')
})

it('keeps the menu label geometry and the badge/action slot fixed across hover states', () => {
  const rest = renderToStaticMarkup(
    <SidebarMenuItem>
      <SidebarMenuButton label="Fix checkout retry" />
      <SidebarMenuBadge>2</SidebarMenuBadge>
      <SidebarMenuAction aria-label="More actions" showOnHover>More</SidebarMenuAction>
    </SidebarMenuItem>,
  )
  const hover = renderToStaticMarkup(
    <SidebarMenuItem data-showcase-hover="true">
      <SidebarMenuButton label="Fix checkout retry" />
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
  expect(rest).toContain('text-base')
  expect(slotClass(rest, 'badge')).toContain('sidebar-menu-trailing-slot')
  expect(slotClass(rest, 'action')).toContain('sidebar-menu-trailing-slot')
  expect(slotClass(rest, 'badge')).toContain('end-(--hd-space-1)')
  expect(slotClass(rest, 'action')).toContain('end-(--hd-space-1)')
  expect(slotClass(rest, 'action')).toContain('bg-sidebar')
  expect(slotClass(rest, 'action')).toContain('group-hover/menu-item:opacity-100')
  expect(slotClass(rest, 'action')).toContain('group-focus-within/menu-item:opacity-100')
  expect(slotClass(rest, 'action')).toContain('data-[state=open]:opacity-100')
  expect(rest).toContain('pe-(--hd-space-8)')
  expect(hover).toContain('pe-(--hd-space-8)')
})

it('renders group and menu actions as named buttons', () => {
  const markup = renderToStaticMarkup(
    <>
      <SidebarGroupAction aria-label="Add project" />
      <SidebarMenuAction aria-label="More actions" />
    </>,
  )

  expect(markup).toContain('<button')
  expect(markup).toContain('aria-label="Add project"')
  expect(markup).toContain('aria-label="More actions"')
  expect(markup.match(/<button/g)).toHaveLength(2)
})

it('renders a menu skeleton without text', () => {
  const markup = renderToStaticMarkup(<SidebarMenuSkeleton showIcon />)
  expect(markup).toContain('data-slot="sidebar-menu-skeleton"')
  expect(markup).toContain('data-sidebar="menu-skeleton-icon"')
  expect(markup).toContain('data-sidebar="menu-skeleton-text"')
  expect(markup.replace(/<[^>]+>/g, '').trim()).toBe('')
})

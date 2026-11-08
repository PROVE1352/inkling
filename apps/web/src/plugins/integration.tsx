// Glue between active plugins and existing app surfaces (command palette, slash menu).
// Each hook returns [] when the `plugins` experiment is off, so call sites need no flag checks.
import { useMemo, type ReactNode } from 'react'
import type { BlockNoteEditor } from '@blocknote/core'
import type { DefaultReactSuggestionItem } from '@blocknote/react'
import { PlugIcon } from '../components/Icons'
import { usePlugins, usePluginsEnabled } from './api'
import { PLUGIN_STRINGS as S } from './strings'
import { insertFromSlash, type SlashEditor } from '../lib/slashInsert'

/** Same shape as CommandPalette's internal Item. */
export type PluginPaletteItem = {
  key: string
  icon: ReactNode
  label: string
  hint?: string
  run: () => void
}

export function usePluginCommandItems(): PluginPaletteItem[] {
  const enabled = usePluginsEnabled()
  const plugins = usePlugins()
  return useMemo(() => {
    if (!enabled) return []
    return (plugins.data ?? []).flatMap((p) =>
      p.permissions.includes('commands')
        ? p.commands.map((c) => ({
            key: `plugin-${p.id}-${c.id}`,
            icon: <PlugIcon size={15} />,
            label: c.title,
            hint: S.paletteHint(p.name),
            // host.ts (iframe broker) loads on first use — it is not part of the app shell.
            run: () =>
              void import('./host').then((h) => h.runPluginCommand(p, c.id, h.contextFromLocation())),
          }))
        : [],
    )
  }, [enabled, plugins.data])
}

export function usePluginSlashItems(
  editor: BlockNoteEditor<any, any, any>,
): DefaultReactSuggestionItem[] {
  const enabled = usePluginsEnabled()
  const plugins = usePlugins()
  return useMemo(() => {
    if (!enabled) return []
    return (plugins.data ?? []).flatMap((p) =>
      p.permissions.includes('blocks')
        ? p.blocks.map((b) => ({
            title: b.title,
            subtext: b.description || S.slashSubtext(p.name),
            aliases: [p.id, b.type, 'plugin'],
            group: S.slashGroup,
            icon: <PlugIcon size={16} />,
            // a plugin block has no text of its own: the caret goes to an empty line below it
            onItemClick: () => {
              const block = {
                type: 'pluginBlock',
                props: { pluginId: p.id, blockType: b.type, data: JSON.stringify(b.defaultData ?? {}) },
              }
              insertFromSlash(editor as unknown as SlashEditor, block, 'below')
            },
          }))
        : [],
    )
  }, [enabled, plugins.data, editor])
}

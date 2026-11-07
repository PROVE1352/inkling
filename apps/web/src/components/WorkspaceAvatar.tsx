// Workspace avatar — shows the icon (emoji) when one is set, otherwise the first letter of the
// name in a colored rounded square (Notion/Slack style). The color is fixed by a hash of the name,
// so each workspace gets its own. Previously every workspace fell back to the same 🗂️, which made
// them hard to tell apart and looked odd (2026-09-23).

function hueOf(name: string): number {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return h % 360
}

export function WorkspaceAvatar({
  name,
  icon,
  size = 20,
}: {
  name: string
  icon?: string | null
  size?: number
}) {
  if (icon) {
    return (
      <span className="shrink-0 leading-none" style={{ fontSize: size * 0.8 }} aria-hidden>
        {icon}
      </span>
    )
  }
  const letter = Array.from(name.trim())[0]?.toUpperCase() ?? '?'
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 select-none items-center justify-center rounded-[5px] font-semibold leading-none text-white"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.55),
        background: `hsl(${hueOf(name)} 45% 52%)`,
      }}
    >
      {letter}
    </span>
  )
}

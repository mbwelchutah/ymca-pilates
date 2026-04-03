export type Tab = 'now' | 'plan' | 'settings'

interface TabBarProps {
  active: Tab
  onChange: (tab: Tab) => void
}

function IconNow({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={active ? 2 : 1.75}
      strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2.5" />
    </svg>
  )
}

function IconPlan({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={active ? 2 : 1.75}
      strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 3v2h6V3" />
      <path d="M9 11h6M9 15h4" />
    </svg>
  )
}

function IconSettings({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={active ? 2 : 1.75}
      strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

const tabs: { id: Tab; label: string; Icon: React.FC<{ active: boolean }> }[] = [
  { id: 'now',      label: 'Now',      Icon: IconNow      },
  { id: 'plan',     label: 'Plan',     Icon: IconPlan     },
  { id: 'settings', label: 'Settings', Icon: IconSettings },
]

export function TabBar({ active, onChange }: TabBarProps) {
  return (
    <nav
      className="
        fixed bottom-0 left-0 right-0 z-50
        bg-white/90 backdrop-blur-md
        border-t border-divider
        flex items-stretch
      "
      style={{ paddingBottom: 'max(0px, env(safe-area-inset-bottom))' }}
    >
      {tabs.map(tab => {
        const isActive = active === tab.id
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`
              flex-1 flex flex-col items-center justify-center gap-1
              pt-2 pb-1.5 min-h-[56px]
              transition-colors active:bg-divider
              ${isActive ? 'text-accent-blue' : 'text-text-muted'}
            `}
          >
            <tab.Icon active={isActive} />
            <span className={`text-[10px] font-semibold tracking-wide ${isActive ? 'text-accent-blue' : 'text-text-muted'}`}>
              {tab.label}
            </span>
          </button>
        )
      })}
    </nav>
  )
}

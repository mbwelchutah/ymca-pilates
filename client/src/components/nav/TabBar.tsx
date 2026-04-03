export type Tab = 'now' | 'plan' | 'settings'

interface TabBarProps {
  active: Tab
  onChange: (tab: Tab) => void
}

const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: 'now',      label: 'Now',      icon: '⏱' },
  { id: 'plan',     label: 'Plan',     icon: '📋' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
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
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`
            flex-1 flex flex-col items-center justify-center gap-0.5
            pt-2 pb-1.5 min-h-[56px]
            transition-colors active:bg-divider
            ${active === tab.id ? 'text-accent-blue' : 'text-text-muted'}
          `}
        >
          <span className="text-[18px] leading-none">{tab.icon}</span>
          <span className={`text-[10px] font-semibold tracking-wide ${active === tab.id ? 'text-accent-blue' : 'text-text-muted'}`}>
            {tab.label}
          </span>
        </button>
      ))}
    </nav>
  )
}

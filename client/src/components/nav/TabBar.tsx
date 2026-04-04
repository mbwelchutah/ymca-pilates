export type Tab = 'now' | 'plan' | 'tools' | 'settings'

interface TabBarProps {
  active: Tab
  onChange: (tab: Tab) => void
}

const tabs: { id: Tab; label: string }[] = [
  { id: 'now',      label: 'Now'      },
  { id: 'plan',     label: 'Plan'     },
  { id: 'tools',    label: 'Tools'    },
  { id: 'settings', label: 'Settings' },
]

export function TabBar({ active, onChange }: TabBarProps) {
  return (
    <nav
      className="fixed left-0 right-0 z-50 bg-white/95 backdrop-blur-md border-b border-divider"
      style={{ top: 'calc(env(safe-area-inset-top) + 73px)' }}
    >
      <div className="flex h-11">
        {tabs.map(tab => {
          const isActive = active === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => onChange(tab.id)}
              className={`
                flex-1 flex items-center justify-center
                text-[14px] font-semibold tracking-wide
                transition-colors relative
                ${isActive ? 'text-accent-blue' : 'text-text-muted'}
              `}
            >
              {tab.label}
              {isActive && (
                <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-8 h-[2px] rounded-full bg-accent-blue" />
              )}
            </button>
          )
        })}
      </div>
    </nav>
  )
}

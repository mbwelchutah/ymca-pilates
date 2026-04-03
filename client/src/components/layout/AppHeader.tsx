interface AppHeaderProps {
  subtitle?: string
  action?: {
    label: string
    onClick: () => void
  }
}

export function AppHeader({ subtitle = 'Monitoring', action }: AppHeaderProps) {
  return (
    <div className="safe-top px-4 pb-2 flex items-center justify-between">
      <div>
        <h1 className="text-[22px] font-bold tracking-tight text-text-primary leading-tight">
          YMCA Booker
        </h1>
        <p className="text-[13px] text-text-secondary font-medium mt-0.5">{subtitle}</p>
      </div>
      {action && (
        <button
          onClick={action.onClick}
          className="text-[13px] font-semibold text-accent-blue active:opacity-70 transition-opacity"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}

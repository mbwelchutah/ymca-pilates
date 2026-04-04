interface Action {
  label: string
  onClick: () => void
}

interface AppHeaderProps {
  subtitle?: string
  action?: Action
  secondaryAction?: Action
}

export function AppHeader({ subtitle = 'Monitoring', action, secondaryAction }: AppHeaderProps) {
  return (
    <div
      className="fixed top-0 left-0 right-0 z-[51] bg-white/95 backdrop-blur-md border-b border-divider"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="pt-4 px-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight text-text-primary leading-tight">
            YMCA Booker
          </h1>
          <p className="text-[13px] text-text-secondary font-medium mt-0.5">{subtitle}</p>
        </div>
        {(action || secondaryAction) && (
          <div className="flex items-center gap-3">
            {secondaryAction && (
              <button
                onClick={secondaryAction.onClick}
                className="text-[13px] font-semibold text-text-secondary active:opacity-70 transition-opacity"
              >
                {secondaryAction.label}
              </button>
            )}
            {action && (
              <button
                onClick={action.onClick}
                className="text-[13px] font-semibold text-accent-blue active:opacity-70 transition-opacity"
              >
                {action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

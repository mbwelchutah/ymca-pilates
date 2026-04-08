import { StatusDot } from '../ui/StatusDot'
import type { AuthStatusEnum } from '../../types'

interface Action {
  label: string
  onClick: () => void
}

interface AppHeaderProps {
  subtitle?: string
  action?: Action
  secondaryAction?: Action
  onAccount?: () => void
  accountAttention?: boolean
  authStatus?: AuthStatusEnum | null
}

function dotProps(authStatus: AuthStatusEnum | null | undefined, accountAttention: boolean | undefined): {
  color: 'green' | 'amber' | 'red' | 'gray' | 'blue'
  pulse: boolean
} | null {
  if (authStatus === 'connected')     return { color: 'green', pulse: false }
  if (authStatus === 'recovering')    return { color: 'blue',  pulse: true  }
  if (authStatus === 'needs_refresh') return { color: 'amber', pulse: false }
  if (authStatus === 'signed_out')    return { color: 'red',   pulse: false }
  // Legacy fallback: accountAttention boolean only
  if (accountAttention)               return { color: 'amber', pulse: false }
  return null
}

export function AppHeader({ subtitle = 'Monitoring', action, secondaryAction, onAccount, accountAttention, authStatus }: AppHeaderProps) {
  const dot = onAccount ? dotProps(authStatus, accountAttention) : null

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[51] bg-white/95 backdrop-blur-md border-b border-divider"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="pt-4 px-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight text-text-primary leading-tight">
            YMCA BOT
          </h1>
          <p className="text-[13px] text-text-secondary font-medium mt-0.5">{subtitle}</p>
        </div>

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
          {onAccount && (
            <button
              onClick={onAccount}
              aria-label="Account"
              className="relative w-8 h-8 flex items-center justify-center rounded-full text-text-secondary active:bg-surface transition-colors"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="8" r="4" />
                <path d="M4 20c0-4 3.582-7 8-7s8 3 8 7" />
              </svg>
              {dot && (
                <span className="absolute top-0.5 right-0.5">
                  <StatusDot color={dot.color} pulse={dot.pulse} size="sm" />
                </span>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

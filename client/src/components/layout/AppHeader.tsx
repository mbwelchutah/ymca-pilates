import { StatusDot } from '../ui/StatusDot'
import type { AuthStatusEnum } from '../../types'
import type { Tab } from '../nav/TabBar'

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
  tab: Tab
  onTabChange: (tab: Tab) => void
  scrolled?: boolean
}

const tabs: { id: Tab; label: string }[] = [
  { id: 'now',      label: 'Now'      },
  { id: 'plan',     label: 'Plan'     },
  { id: 'tools',    label: 'Tools'    },
  { id: 'settings', label: 'Settings' },
]

function dotProps(
  authStatus: AuthStatusEnum | null | undefined,
  accountAttention: boolean | undefined,
): { color: 'green' | 'amber' | 'red' | 'gray' | 'blue'; pulse: boolean } | null {
  if (authStatus === 'connected')     return { color: 'green', pulse: false }
  if (authStatus === 'recovering')    return { color: 'blue',  pulse: true  }
  if (authStatus === 'needs_refresh') return { color: 'amber', pulse: false }
  if (authStatus === 'signed_out')    return { color: 'red',   pulse: false }
  if (accountAttention)               return { color: 'amber', pulse: false }
  return null
}

export function AppHeader({
  subtitle,
  action,
  secondaryAction,
  onAccount,
  accountAttention,
  authStatus,
  tab,
  onTabChange,
  scrolled = false,
}: AppHeaderProps) {
  const dot = onAccount ? dotProps(authStatus, accountAttention) : null
  const activeIdx = tabs.findIndex(t => t.id === tab)

  return (
    <div
      className={`fixed top-0 left-0 right-0 z-[51] transition-colors duration-200 ${
        scrolled
          ? 'bg-white/72 backdrop-blur-xl backdrop-saturate-[1.8] border-b border-[var(--color-hairline)]'
          : 'bg-white/85 backdrop-blur-xl backdrop-saturate-[1.8]'
      }`}
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      {/* ── Row 1: Large title (collapses on scroll) + right-side actions ── */}
      <div
        className={`px-5 flex items-end justify-between transition-all duration-250 ${
          scrolled ? 'pt-2 pb-1' : 'pt-3.5 pb-1'
        }`}
      >
        <div>
          <h1
            className={`font-bold tracking-tight text-text-primary leading-none transition-all duration-250 ${
              scrolled ? 'text-[17px]' : 'text-[28px]'
            }`}
          >
            YMCA BOT
          </h1>
          {/* Subtitle — visible only in large (unscrolled) state */}
          <div
            className={`overflow-hidden transition-all duration-200 ${
              scrolled ? 'max-h-0 opacity-0' : 'max-h-6 opacity-100'
            }`}
          >
            {subtitle && (
              <p className="text-[12px] text-text-secondary font-medium mt-1 leading-none">
                {subtitle}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 pb-0.5">
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

      {/* ── Row 2: iOS-style segmented pill control ── */}
      <div className="px-5 pt-2 pb-2.5">
        <div className="relative flex items-center bg-[#E5E5EA] rounded-[10px] p-[2px]">
          {/* Sliding white pill — absolute positioned, driven by activeIdx */}
          <div
            className="absolute top-[2px] bottom-[2px] rounded-[8px] bg-white transition-transform duration-200 ease-in-out"
            style={{
              width: `calc((100% - 4px) / 4)`,
              transform: `translateX(calc(${activeIdx} * 100%))`,
              boxShadow: '0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08)',
            }}
          />
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => onTabChange(t.id)}
              className={`relative flex-1 py-[5px] text-[13px] font-semibold rounded-[8px] z-10 select-none transition-colors duration-150 ${
                tab === t.id ? 'text-[#1C1C1E]' : 'text-[#6C6C70]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

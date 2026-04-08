import { useState, useEffect, useCallback } from 'react'
import type { SessionStatus, AuthStatusEnum } from '../types'
import { StatusDot } from './ui/StatusDot'
import { api } from '../lib/api'

interface AccountSheetProps {
  open: boolean
  onClose: () => void
  polledStatus?: SessionStatus | null
}

// ── Time formatter ────────────────────────────────────────────────────────────

function formatRelative(ms: number | null | undefined): string {
  if (!ms) return 'Never'
  const diff = Date.now() - ms
  if (diff < 60_000)             return 'just now'
  if (diff < 3_600_000)          return `${Math.floor(diff / 60_000)} min ago`
  if (diff < 86_400_000)         return `${Math.floor(diff / 3_600_000)} hr ago`
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(ms))
}

function formatChecked(iso: string | null): string {
  if (!iso) return 'Never'
  try {
    const d = new Date(iso)
    return new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(d)
  } catch {
    return '—'
  }
}

// ── AuthState → display mapping ────────────────────────────────────────────────

interface DisplayInfo {
  headline:       string
  subline:        string
  dotColor:       'green' | 'amber' | 'red' | 'gray' | 'blue'
  dotPulse:       boolean
  headlineCls:    string
  signedIn:       boolean
  needsAttention: boolean
  inProgress:     boolean
}

function deriveDisplay(s: SessionStatus | null): DisplayInfo {
  // ── AuthState path (Stage 1+ canonical source) ─────────────────────────────
  const auth = s?.authState
  if (auth) {
    const inProgress = auth.isAuthInProgress === true

    if (auth.status === 'connected') return {
      headline:       'Connected',
      subline:        'Daxko and schedule are active',
      dotColor:       'green',
      dotPulse:       false,
      headlineCls:    'text-text-primary',
      signedIn:       true,
      needsAttention: false,
      inProgress,
    }

    if (auth.status === 'recovering') return {
      headline:       'Signing in…',
      subline:        'Authentication in progress',
      dotColor:       'blue',
      dotPulse:       true,
      headlineCls:    'text-accent-blue',
      signedIn:       false,
      needsAttention: false,
      inProgress:     true,
    }

    if (auth.status === 'needs_refresh') return {
      headline:       'Needs refresh',
      subline:        auth.daxkoValid
        ? 'Schedule connection lost — tap Refresh'
        : 'Session expired — tap Sign in',
      dotColor:       'amber',
      dotPulse:       false,
      headlineCls:    'text-accent-amber',
      signedIn:       auth.daxkoValid,
      needsAttention: true,
      inProgress,
    }

    if (auth.status === 'signed_out') return {
      headline:       'Signed out',
      subline:        'Sign in to enable booking',
      dotColor:       'red',
      dotPulse:       false,
      headlineCls:    'text-accent-red',
      signedIn:       false,
      needsAttention: true,
      inProgress,
    }
  }

  // ── Legacy fallback (pre-AuthState or cold start) ─────────────────────────
  if (!s) return {
    headline:       'Checking…',
    subline:        '—',
    dotColor:       'gray',
    dotPulse:       false,
    headlineCls:    'text-text-secondary',
    signedIn:       false,
    needsAttention: false,
    inProgress:     false,
  }

  const signedIn   = s.daxko       === 'DAXKO_READY'
  const connActive = s.familyworks === 'FAMILYWORKS_READY'

  if (!signedIn) return {
    headline:       'Needs attention',
    subline:        'Sign-in required',
    dotColor:       'amber',
    dotPulse:       false,
    headlineCls:    'text-accent-red',
    signedIn:       false,
    needsAttention: true,
    inProgress:     false,
  }

  if (!connActive) return {
    headline:       'Signed in',
    subline:        'Schedule connection lost',
    dotColor:       'amber',
    dotPulse:       false,
    headlineCls:    'text-text-primary',
    signedIn:       true,
    needsAttention: true,
    inProgress:     false,
  }

  return {
    headline:       'Connected',
    subline:        'Daxko and schedule are active',
    dotColor:       'green',
    dotPulse:       false,
    headlineCls:    'text-text-primary',
    signedIn:       true,
    needsAttention: false,
    inProgress:     false,
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AccountSheet({ open, onClose, polledStatus }: AccountSheetProps) {
  const [session,    setSession]    = useState<SessionStatus | null>(null)
  const [signingIn,  setSigningIn]  = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [feedback,   setFeedback]   = useState<{ text: string; cls: string } | null>(null)
  const [expanded,   setExpanded]   = useState(false)

  const fetchSession = useCallback(() => {
    api.getSessionStatus()
      .then(s => setSession(s))
      .catch(() => setSession(null))
  }, [])

  // Fetch fresh status on open; collapse details on each open.
  useEffect(() => {
    if (open) {
      setFeedback(null)
      setExpanded(false)
      fetchSession()
    }
  }, [open, fetchSession])

  // Merge background poll while open.
  useEffect(() => {
    if (open && polledStatus != null) {
      setSession(polledStatus)
    }
  }, [open, polledStatus])

  const busy = signingIn || refreshing || signingOut

  const handleSignIn = async () => {
    if (busy) return
    setSigningIn(true)
    setFeedback({ text: 'Signing in — this takes about 30 seconds…', cls: 'text-text-secondary' })
    try {
      const result = await api.settingsLogin()
      if (result.success) {
        setFeedback({ text: result.detail ?? 'Signed in successfully', cls: 'text-accent-green' })
      } else {
        setFeedback({ text: result.detail ?? 'Sign-in failed — check credentials in Settings', cls: 'text-accent-red' })
      }
      fetchSession()
    } catch {
      setFeedback({ text: 'Could not reach server — try again', cls: 'text-accent-red' })
    } finally {
      setSigningIn(false)
    }
  }

  const handleRefresh = async () => {
    if (busy) return
    setRefreshing(true)
    setFeedback({ text: 'Checking connection…', cls: 'text-text-secondary' })
    try {
      const result = await api.settingsRefresh()
      if (result.success) {
        const text = result.tier === 2
          ? 'Connection verified'
          : 'Connection confirmed (full check)'
        setFeedback({ text, cls: 'text-accent-green' })
      } else {
        setFeedback({ text: result.detail ?? 'Could not confirm connection', cls: 'text-accent-amber' })
      }
      fetchSession()
    } catch {
      setFeedback({ text: 'Could not reach server — try again', cls: 'text-accent-red' })
    } finally {
      setRefreshing(false)
    }
  }

  const handleSignOut = async () => {
    if (busy) return
    setSigningOut(true)
    setFeedback({ text: 'Signing out…', cls: 'text-text-secondary' })
    try {
      const result = await api.settingsClear()
      if (result.success) {
        setFeedback({ text: 'Signed out', cls: 'text-text-secondary' })
        fetchSession()
      } else {
        setFeedback({ text: result.detail ?? 'Sign-out failed', cls: 'text-accent-red' })
      }
    } catch {
      setFeedback({ text: 'Could not reach server — try again', cls: 'text-accent-red' })
    } finally {
      setSigningOut(false)
    }
  }

  const info = deriveDisplay(session)
  const auth = session?.authState ?? null
  const lastCheckedMs = auth?.lastCheckedAt ?? null

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className={`fixed inset-0 z-[60] bg-black/30 transition-opacity duration-300 ${open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
      />

      {/* Sheet */}
      <div
        className={`
          fixed left-0 right-0 bottom-0 z-[61]
          bg-white rounded-t-[20px] shadow-2xl
          transition-transform duration-300 ease-out
          ${open ? 'translate-y-0' : 'translate-y-full'}
        `}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-9 h-1 rounded-full bg-[#e5e5ea]" />
        </div>

        <div className="px-6 pt-3 pb-8">

          {/* ── Sheet header ──────────────────────────────────────────── */}
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-[20px] font-bold text-text-primary tracking-tight">Account</h2>
            <button
              onClick={onClose}
              className="text-[14px] font-semibold text-accent-blue active:opacity-70 transition-opacity"
            >
              Done
            </button>
          </div>

          {/* ── Collapsed status block ────────────────────────────────── */}
          <div className="bg-[#f2f2f7] rounded-2xl px-4 py-4 mb-4">
            <div className="flex items-center gap-3">
              <StatusDot color={info.dotColor} pulse={info.dotPulse} size="md" />
              <div className="flex-1 min-w-0">
                <p className={`text-[17px] font-semibold leading-tight ${info.headlineCls}`}>
                  {info.headline}
                </p>
                <p className="text-[13px] text-text-secondary mt-0.5 leading-snug">
                  {info.subline}
                </p>
              </div>
            </div>

            {/* Last checked — shown below the headline */}
            <p className="text-[12px] text-text-muted mt-3 leading-none">
              {lastCheckedMs
                ? `Checked ${formatRelative(lastCheckedMs)}`
                : session?.lastVerified
                  ? `Checked ${formatChecked(session.lastVerified)}`
                  : 'Not yet checked'}
            </p>
          </div>

          {/* ── Details expander (Stage 7 will populate the body) ────── */}
          <button
            onClick={() => setExpanded(e => !e)}
            className="w-full flex items-center justify-between py-2.5 px-1 mb-3 active:opacity-60 transition-opacity"
            aria-expanded={expanded}
          >
            <span className="text-[13px] font-medium text-text-secondary">Details</span>
            <svg
              width="16" height="16" viewBox="0 0 16 16" fill="none"
              className={`text-text-muted transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
            >
              <path d="M3 6l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {/* ── Expanded details panel (placeholder — Stage 7) ──────── */}
          {expanded && (
            <div className="bg-[#f2f2f7] rounded-2xl px-4 py-3 mb-4">
              <div className="flex flex-col gap-2.5 text-[13px]">
                <div className="flex items-center justify-between">
                  <span className="text-text-secondary">Daxko</span>
                  <span className={`font-medium ${auth?.daxkoValid ? 'text-accent-green' : 'text-accent-red'}`}>
                    {auth ? (auth.daxkoValid ? 'Valid' : 'Invalid') : session?.daxko === 'DAXKO_READY' ? 'Valid' : '—'}
                  </span>
                </div>
                <div className="w-full h-px bg-[#e5e5ea]" />
                <div className="flex items-center justify-between">
                  <span className="text-text-secondary">Schedule</span>
                  <span className={`font-medium ${auth?.familyworksValid ? 'text-accent-green' : 'text-accent-red'}`}>
                    {auth ? (auth.familyworksValid ? 'Active' : 'Inactive') : session?.familyworks === 'FAMILYWORKS_READY' ? 'Active' : '—'}
                  </span>
                </div>
                {auth?.lastRecoveredAt && (
                  <>
                    <div className="w-full h-px bg-[#e5e5ea]" />
                    <div className="flex items-center justify-between">
                      <span className="text-text-secondary">Last login</span>
                      <span className="font-medium text-text-primary">{formatRelative(auth.lastRecoveredAt)}</span>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* ── Feedback ─────────────────────────────────────────────── */}
          {feedback && (
            <p className={`text-[13px] mb-3 ${feedback.cls}`}>{feedback.text}</p>
          )}

          {/* ── Actions ──────────────────────────────────────────────── */}
          <div className="flex flex-col gap-2.5">
            {!info.signedIn ? (
              <>
                <button
                  onClick={handleSignIn}
                  disabled={busy}
                  className={`w-full py-3 rounded-xl bg-accent-blue text-white text-[15px] font-semibold transition-opacity ${busy ? 'opacity-50' : 'active:opacity-80'}`}
                >
                  {signingIn ? 'Signing in…' : 'Sign in'}
                </button>
                <button
                  onClick={handleRefresh}
                  disabled={busy}
                  className={`w-full py-3 rounded-xl bg-[#f2f2f7] text-text-primary text-[15px] font-semibold transition-opacity ${busy ? 'opacity-50' : 'active:opacity-80'}`}
                >
                  {refreshing ? 'Checking…' : 'Verify connection'}
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={handleRefresh}
                  disabled={busy}
                  className={`w-full py-3 rounded-xl bg-accent-blue text-white text-[15px] font-semibold transition-opacity ${busy ? 'opacity-50' : 'active:opacity-80'}`}
                >
                  {refreshing ? 'Checking…' : 'Verify connection'}
                </button>
                <button
                  onClick={handleSignIn}
                  disabled={busy}
                  className={`w-full py-3 rounded-xl bg-[#f2f2f7] text-text-primary text-[15px] font-semibold transition-opacity ${busy ? 'opacity-50' : 'active:opacity-80'}`}
                >
                  {signingIn ? 'Signing in…' : 'Sign in again'}
                </button>
              </>
            )}

            <button
              onClick={handleSignOut}
              disabled={busy}
              className={`w-full py-3 rounded-xl bg-[#f2f2f7] text-accent-red text-[15px] font-semibold transition-opacity ${busy ? 'opacity-50' : 'active:opacity-80'}`}
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>

        </div>
      </div>
    </>
  )
}

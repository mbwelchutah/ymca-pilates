import { useState, useEffect, useCallback } from 'react'
import type { SessionStatus } from '../types'
import { api } from '../lib/api'

interface AccountSheetProps {
  open: boolean
  onClose: () => void
  polledStatus?: SessionStatus | null
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

function deriveStatus(s: SessionStatus | null): {
  headline: string
  headlineCls: string
  dot: 'green' | 'amber' | 'gray'
  connection: string
  connectionCls: string
  signedIn: boolean
  needsAttention: boolean
} {
  if (!s) return {
    headline: 'Checking…',
    headlineCls: 'text-text-secondary',
    dot: 'gray',
    connection: '—',
    connectionCls: 'text-text-muted',
    signedIn: false,
    needsAttention: false,
  }

  const signedIn   = s.daxko       === 'DAXKO_READY'
  const connActive = s.familyworks === 'FAMILYWORKS_READY'

  if (!signedIn) return {
    headline: 'Needs attention',
    headlineCls: 'text-accent-red',
    dot: 'amber',
    connection: 'Sign-in required',
    connectionCls: 'text-accent-amber',
    signedIn: false,
    needsAttention: true,
  }

  if (!connActive) return {
    headline: 'Signed in',
    headlineCls: 'text-text-primary',
    dot: 'amber',
    connection: 'Schedule disconnected',
    connectionCls: 'text-accent-amber',
    signedIn: true,
    needsAttention: true,
  }

  return {
    headline: 'Signed in',
    headlineCls: 'text-text-primary',
    dot: 'green',
    connection: 'Connection active',
    connectionCls: 'text-accent-green',
    signedIn: true,
    needsAttention: false,
  }
}

const DOT_CLS: Record<'green' | 'amber' | 'gray', string> = {
  green: 'bg-accent-green',
  amber: 'bg-accent-amber',
  gray:  'bg-[#c7c7cc]',
}

export function AccountSheet({ open, onClose, polledStatus }: AccountSheetProps) {
  const [session,    setSession]    = useState<SessionStatus | null>(null)
  const [signingIn,  setSigningIn]  = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [feedback,   setFeedback]   = useState<{ text: string; cls: string } | null>(null)

  const fetchSession = useCallback(() => {
    api.getSessionStatus()
      .then(s => setSession(s))
      .catch(() => setSession(null))
  }, [])

  // Fetch fresh status on open.
  useEffect(() => {
    if (open) {
      setFeedback(null)
      fetchSession()
    }
  }, [open, fetchSession])

  // When App's background poll produces a newer status while the sheet is
  // open, merge it in so "Last checked" updates without user action.
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

  const info = deriveStatus(session)

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
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-[20px] font-bold text-text-primary tracking-tight">Account</h2>
            <button
              onClick={onClose}
              className="text-[14px] font-semibold text-accent-blue active:opacity-70 transition-opacity"
            >
              Done
            </button>
          </div>

          {/* Status block */}
          <div className="bg-[#f2f2f7] rounded-2xl px-4 py-4 mb-5">
            <div className="flex items-center gap-2.5 mb-1">
              <span className={`w-2 h-2 rounded-full shrink-0 ${DOT_CLS[info.dot]}`} />
              <span className={`text-[17px] font-semibold ${info.headlineCls}`}>{info.headline}</span>
            </div>
            <p className={`text-[14px] ml-[18px] ${info.connectionCls}`}>{info.connection}</p>
            <p className="text-[13px] text-text-muted mt-2 ml-[18px]">
              Last checked: {formatChecked(session?.lastVerified ?? null)}
            </p>
          </div>

          {/* Feedback */}
          {feedback && (
            <p className={`text-[13px] mb-3 ${feedback.cls}`}>{feedback.text}</p>
          )}

          {/* Actions — layout shifts based on whether sign-in is the primary need */}
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
                  {refreshing ? 'Checking…' : 'Refresh connection'}
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={handleRefresh}
                  disabled={busy}
                  className={`w-full py-3 rounded-xl bg-accent-blue text-white text-[15px] font-semibold transition-opacity ${busy ? 'opacity-50' : 'active:opacity-80'}`}
                >
                  {refreshing ? 'Checking…' : 'Refresh connection'}
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

import { useState, useEffect, useCallback, useRef } from 'react'
import type { SessionStatus, ConnectionState, OperationState } from '../types'
import { StatusDot } from './ui/StatusDot'
import { api } from '../lib/api'

// ── Live tick — refreshes relative time labels while sheet is open ─────────────

function useTick(intervalMs: number, active: boolean) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick(t => t + 1), intervalMs)
    return () => clearInterval(id)
  }, [active, intervalMs])
  return tick
}

// ── Inline spinner for busy buttons ───────────────────────────────────────────

function Spinner() {
  return (
    <svg
      className="inline w-3.5 h-3.5 mr-1.5 animate-spin align-[-2px]"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="2" strokeOpacity="0.3" />
      <path d="M7 1.5A5.5 5.5 0 0 1 12.5 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

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

// ── Stage 1: Separate connection truth from operation state ───────────────────
//
// ConnectionInfo — the settled truth about whether the session is live.
// Derived from AuthState validity flags, NOT from isAuthInProgress or local
// button state. A background re-auth should not change the headline from
// "Connected" to "Signing in…" if the underlying session is still valid.
//
// OperationInfo — what action is currently in flight (if any).
// Secondary context only; rendered below the headline, never replacing it.

interface ConnectionInfo {
  state:          ConnectionState
  headline:       string
  subline:        string
  dotColor:       'green' | 'amber' | 'red' | 'gray'
  headlineCls:    string
  signedIn:       boolean
  needsAttention: boolean
}

interface OperationInfo {
  state: OperationState
  label: string | null
}

function deriveConnectionInfo(s: SessionStatus | null): ConnectionInfo {
  const auth = s?.authState

  if (auth) {
    // Derive connection truth from validity flags, ignoring isAuthInProgress.
    // During 'recovering', the underlying session may still be valid —
    // we report the session truth, not the transient operation.
    const connected = auth.daxkoValid && auth.familyworksValid

    if (connected) return {
      state:          'connected',
      headline:       'Connected',
      subline:        auth.bookingAccessConfirmed
        ? 'Daxko · Schedule · Booking confirmed'
        : 'Daxko and schedule active',
      dotColor:       'green',
      headlineCls:    'text-text-primary',
      signedIn:       true,
      needsAttention: false,
    }

    if (auth.status === 'signed_out' || (!auth.daxkoValid && !auth.familyworksValid && auth.lastCheckedAt === null)) return {
      state:          'needs_attention',
      headline:       'Signed out',
      subline:        'Sign in to enable booking',
      dotColor:       'red',
      headlineCls:    'text-accent-red',
      signedIn:       false,
      needsAttention: true,
    }

    // needs_refresh — partial or expired
    return {
      state:          'needs_attention',
      headline:       'Needs attention',
      subline:        auth.daxkoValid
        ? 'Schedule connection lost'
        : 'Session expired — sign in to continue',
      dotColor:       'amber',
      headlineCls:    'text-accent-amber',
      signedIn:       auth.daxkoValid,
      needsAttention: true,
    }
  }

  // authState is always present in server responses. If we reach here without
  // it, we haven't received any status yet — treat as unknown.
  return {
    state:          'unknown',
    headline:       'Checking…',
    subline:        '—',
    dotColor:       'gray',
    headlineCls:    'text-text-secondary',
    signedIn:       false,
    needsAttention: false,
  }
}

function deriveOperationInfo(
  s:          SessionStatus | null,
  signingIn:  boolean,
  refreshing: boolean,
): OperationInfo {
  const auth         = s?.authState
  const locked       = s?.locked ?? false
  const bookingActive = s?.bookingActive ?? false

  // Booking run takes priority over every auth label — prevents mislabeling
  // a booking-time auth step as "Signing in" from the user's perspective.
  if (bookingActive) {
    return { state: 'blocked_by_booking', label: 'Booking run in progress' }
  }

  // Local button state takes precedence over background / server-pushed state.
  if (signingIn)  return { state: 'signing_in', label: 'Signing in…' }
  if (refreshing) return { state: 'refreshing', label: 'Verifying connection…' }

  // Auth lock held — use authOperation for an accurate label instead of
  // the old session-validity heuristic.
  if (auth?.isAuthInProgress) {
    const op = auth.authOperation
    if (op === 'signing_in') return { state: 'signing_in', label: 'Signing in…' }
    if (op === 'verifying')  return { state: 'verifying',  label: 'Verifying connection…' }
    if (op === 'refreshing') return { state: 'refreshing', label: 'Refreshing…' }
    if (op === 'recovery')   return { state: 'refreshing', label: 'Recovering session…' }
    // Backward-compat fallback when authOperation is not provided.
    const sessionValid = auth.daxkoValid && auth.familyworksValid
    return sessionValid
      ? { state: 'refreshing', label: 'Refreshing session…' }
      : { state: 'signing_in', label: 'Signing in…' }
  }

  // Lock held without auth in progress (old servers without bookingActive).
  if (locked && !auth?.isAuthInProgress) {
    return { state: 'blocked_by_booking', label: 'Booking run in progress' }
  }

  return { state: 'idle', label: null }
}

// ── Diagnostic helpers ────────────────────────────────────────────────────────

function Divider() {
  return <div className="w-full h-px bg-[#e5e5ea] my-2" />
}

interface DiagRowProps {
  label:   string
  value:   string
  ok:      boolean | null
  neutral?: boolean
}

function DiagRow({ label, value, ok, neutral = false }: DiagRowProps) {
  let valueCls = 'text-text-primary'
  if (!neutral && ok === true)  valueCls = 'text-accent-green'
  if (!neutral && ok === false) valueCls = 'text-accent-red'

  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[13px] text-text-secondary">{label}</span>
      <span className={`text-[13px] font-medium ${valueCls}`}>{value}</span>
    </div>
  )
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

  // Stage 8: busy includes server-side booking so buttons are disabled while
  // a booking run is active (server would reject auth attempts anyway, and the
  // UI should not let the user start an operation that will immediately fail).
  const bookingRunActive = !!(session?.bookingActive)
  const busy = signingIn || refreshing || signingOut || bookingRunActive

  const handleSignIn = async () => {
    if (busy) return
    setSigningIn(true)
    setFeedback({ text: 'Signing in — this takes about 30 seconds…', cls: 'text-text-secondary' })
    try {
      const result = await api.settingsLogin()
      if (result.success) {
        setFeedback({ text: result.detail ?? 'Signed in successfully', cls: 'text-accent-green' })
      } else {
        setFeedback({ text: result.detail ?? 'Sign-in failed — check server credentials and try again', cls: 'text-accent-red' })
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

  // Tick every 30 s while open — re-renders the relative time labels
  const tick = useTick(30_000, open)
  void tick

  const conn = deriveConnectionInfo(session)
  const op   = deriveOperationInfo(session, signingIn, refreshing)
  const auth = session?.authState ?? null
  const lastCheckedMs = auth?.lastCheckedAt ?? null

  // Stage 7: Stale-operation resolver.
  // While any auth operation is in flight, re-fetch server truth frequently so
  // the UI picks up the resolved state (isAuthInProgress → false, new validity
  // flags) within a few seconds of the backend finishing — even if the local
  // signingIn / refreshing state hasn't cleared yet (e.g. slow network).
  // 3 s is fast enough to feel responsive but slow enough to not spam the server.
  // The interval clears automatically when op.state returns to 'idle'.
  const _staleOpRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (op.state === 'idle') {
      if (_staleOpRef.current !== null) {
        clearInterval(_staleOpRef.current)
        _staleOpRef.current = null
      }
      return
    }
    _staleOpRef.current = setInterval(fetchSession, 3_000)
    return () => {
      if (_staleOpRef.current !== null) {
        clearInterval(_staleOpRef.current)
        _staleOpRef.current = null
      }
    }
  }, [op.state, fetchSession])

  // Stage 7: Max-staleness guards.
  // If the local signingIn / refreshing state stays true for longer than the
  // server-side watchdog could ever take, the HTTP request has likely hung
  // (network stall, server overload). Force-clear the local state, show an
  // informative message, and re-read server truth.
  // Sign-in: 100 s max (server watchdog fires at 120 s — we clear just before).
  // Refresh/verify: 45 s max (Tier-3 Playwright takes ~30 s at most).
  const _signInTimeoutRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const _refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (signingIn) {
      _signInTimeoutRef.current = setTimeout(() => {
        setSigningIn(false)
        setFeedback({ text: 'Sign-in timed out — check server status and try again', cls: 'text-accent-red' })
        fetchSession()
      }, 100_000)
    } else {
      if (_signInTimeoutRef.current !== null) {
        clearTimeout(_signInTimeoutRef.current)
        _signInTimeoutRef.current = null
      }
    }
    return () => {
      if (_signInTimeoutRef.current !== null) {
        clearTimeout(_signInTimeoutRef.current)
        _signInTimeoutRef.current = null
      }
    }
  }, [signingIn, fetchSession])

  useEffect(() => {
    if (refreshing) {
      _refreshTimeoutRef.current = setTimeout(() => {
        setRefreshing(false)
        setFeedback({ text: 'Verification timed out — try again', cls: 'text-accent-red' })
        fetchSession()
      }, 45_000)
    } else {
      if (_refreshTimeoutRef.current !== null) {
        clearTimeout(_refreshTimeoutRef.current)
        _refreshTimeoutRef.current = null
      }
    }
    return () => {
      if (_refreshTimeoutRef.current !== null) {
        clearTimeout(_refreshTimeoutRef.current)
        _refreshTimeoutRef.current = null
      }
    }
  }, [refreshing, fetchSession])

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

            {/* Connection truth — always the primary headline */}
            <div className="flex items-center gap-3">
              <StatusDot color={conn.dotColor} pulse={false} size="md" />
              <div className="flex-1 min-w-0">
                <p className={`text-[17px] font-semibold leading-tight ${conn.headlineCls}`}>
                  {conn.headline}
                </p>
                <p className="text-[13px] text-text-secondary mt-0.5 leading-snug">
                  {conn.subline}
                </p>
              </div>
            </div>

            {/* Operation state — secondary context, shown only when not idle.
                Spinner for active processes (signing in, verifying, refreshing,
                recovering). No spinner for blocked/non-spinning states. */}
            {op.label && (
              <div className="flex items-center gap-1.5 mt-2.5">
                {(op.state === 'signing_in' || op.state === 'verifying' ||
                  op.state === 'refreshing') && (
                  <svg className="w-3 h-3 animate-spin text-text-muted flex-shrink-0" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.3" />
                    <path d="M6 1.5A4.5 4.5 0 0 1 10.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                )}
                <p className="text-[12px] text-text-muted leading-none">{op.label}</p>
              </div>
            )}

            {/* Last checked */}
            <p className="text-[12px] text-text-muted mt-2.5 leading-none">
              {lastCheckedMs
                ? `Checked ${formatRelative(lastCheckedMs)}`
                : session?.lastVerified
                  ? `Checked ${formatChecked(session.lastVerified)}`
                  : 'Not yet checked'}
            </p>
          </div>

          {/* ── Details expander ─────────────────────────────────────── */}
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

          {/* ── Expanded diagnostics panel (Stage 7) ─────────────────── */}
          {expanded && (
            <div className="flex flex-col gap-3 mb-4">

              {/* Group 1 — Connections */}
              <div className="bg-[#f2f2f7] rounded-2xl px-4 py-3">
                <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide mb-2.5">
                  Connections
                </p>
                <DiagRow
                  label="Daxko account"
                  value={auth ? (auth.daxkoValid ? 'Valid' : 'Invalid') : '—'}
                  ok={auth?.daxkoValid ?? null}
                />
                <Divider />
                <DiagRow
                  label="Schedule"
                  value={auth ? (auth.familyworksValid ? 'Active' : 'Inactive') : '—'}
                  ok={auth?.familyworksValid ?? null}
                />
                <Divider />
                <DiagRow
                  label="Booking access"
                  value={
                    !auth                              ? '—'
                    : auth.bookingAccessConfirmed      ? `Confirmed ${formatRelative(auth.bookingAccessConfirmedAt)}`
                    : auth.bookingAccessConfirmedAt !== null ? 'Not confirmed'
                    : 'Not yet checked'
                  }
                  ok={auth?.bookingAccessConfirmed ?? null}
                  neutral={auth ? (!auth.bookingAccessConfirmed && auth.bookingAccessConfirmedAt === null) : false}
                />
              </div>

              {/* Group 2 — Status */}
              <div className="bg-[#f2f2f7] rounded-2xl px-4 py-3">
                <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide mb-2.5">
                  Status
                </p>
                {op.state !== 'idle' && op.label && (
                  <>
                    <DiagRow label="Activity" value={op.label} ok={null} neutral />
                    <Divider />
                  </>
                )}
                <DiagRow
                  label="Last verified"
                  value={lastCheckedMs
                    ? formatRelative(lastCheckedMs)
                    : session?.lastVerified
                      ? formatChecked(session.lastVerified)
                      : 'Never'}
                  ok={null}
                  neutral
                />
                {auth?.lastRecoveredAt && (
                  <>
                    <Divider />
                    <DiagRow
                      label="Last login"
                      value={formatRelative(auth.lastRecoveredAt)}
                      ok={null}
                      neutral
                    />
                  </>
                )}
              </div>

              {/* Group 3 — Last check (session-check.js result) */}
              {(session?.valid !== undefined && session?.valid !== null || session?.detail) && (
                <div className="bg-[#f2f2f7] rounded-2xl px-4 py-3">
                  <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide mb-2.5">
                    Last check
                  </p>
                  <DiagRow
                    label="Result"
                    value={session?.valid === true ? 'Pass' : session?.valid === false ? 'Fail' : '—'}
                    ok={session?.valid === true ? true : session?.valid === false ? false : null}
                    neutral={session?.valid == null}
                  />
                  {session?.detail && (
                    <>
                      <Divider />
                      <div className="pt-1 pb-0.5">
                        <p className="text-[11px] text-text-muted leading-snug line-clamp-3">
                          {session.detail}
                        </p>
                      </div>
                    </>
                  )}
                  {session?.checkedAt && (
                    <>
                      <Divider />
                      <DiagRow
                        label="Checked at"
                        value={formatChecked(session.checkedAt)}
                        ok={null}
                        neutral
                      />
                    </>
                  )}
                </div>
              )}

            </div>
          )}

          {/* ── Feedback ─────────────────────────────────────────────── */}
          {feedback && (
            <p className={`text-[13px] mb-3 ${feedback.cls}`}>{feedback.text}</p>
          )}

          {/* ── Actions ──────────────────────────────────────────────── */}
          <div className="flex flex-col gap-2.5">
            {!conn.signedIn ? (
              <>
                <button
                  onClick={handleSignIn}
                  disabled={busy}
                  className={`w-full py-3 rounded-xl bg-accent-blue text-white text-[15px] font-semibold transition-opacity ${busy ? 'opacity-50 cursor-not-allowed' : 'active:opacity-80'}`}
                >
                  {signingIn ? <><Spinner />Signing in…</> : 'Sign in'}
                </button>
                <button
                  onClick={handleRefresh}
                  disabled={busy}
                  className={`w-full py-3 rounded-xl bg-[#f2f2f7] text-text-primary text-[15px] font-semibold transition-opacity ${busy ? 'opacity-50 cursor-not-allowed' : 'active:opacity-80'}`}
                >
                  {refreshing ? <><Spinner />Checking…</> : 'Verify connection'}
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={handleRefresh}
                  disabled={busy}
                  className={`w-full py-3 rounded-xl bg-accent-blue text-white text-[15px] font-semibold transition-opacity ${busy ? 'opacity-50 cursor-not-allowed' : 'active:opacity-80'}`}
                >
                  {refreshing ? <><Spinner />Checking…</> : 'Verify connection'}
                </button>
                <button
                  onClick={handleSignIn}
                  disabled={busy}
                  className={`w-full py-3 rounded-xl bg-[#f2f2f7] text-text-primary text-[15px] font-semibold transition-opacity ${busy ? 'opacity-50 cursor-not-allowed' : 'active:opacity-80'}`}
                >
                  {signingIn ? <><Spinner />Signing in…</> : 'Sign in again'}
                </button>
              </>
            )}

            <button
              onClick={handleSignOut}
              disabled={busy}
              className={`w-full py-3 rounded-xl bg-[#f2f2f7] text-accent-red text-[15px] font-semibold transition-opacity ${busy ? 'opacity-50 cursor-not-allowed' : 'active:opacity-80'}`}
            >
              {signingOut ? <><Spinner />Signing out…</> : 'Sign out'}
            </button>
          </div>

        </div>
      </div>
    </>
  )
}

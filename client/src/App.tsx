import { useState, useEffect, useRef } from 'react'
import type { Tab } from './components/nav/TabBar'
import { NowScreen } from './screens/NowScreen'
import { PlanScreen } from './screens/PlanScreen'
import { ToolsScreen } from './screens/ToolsScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { AccountSheet } from './components/AccountSheet'
import { useAppState } from './hooks/useAppState'
import { api } from './lib/api'
import { decideStickySelection } from './lib/stickySelection'
import type { SessionStatus, AuthStatusEnum } from './types'

const SESSION_POLL_MS      = 90 * 1000  // 90 s — background steady-state
const AUTH_ACTIVE_POLL_MS  =  3 * 1000  // 3 s — while an auth op is in progress

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const saved = localStorage.getItem('mobileTab')
    return (saved === 'now' || saved === 'plan' || saved === 'tools' || saved === 'settings') ? saved : 'now'
  })

  const [accountOpen, setAccountOpen] = useState(false)
  const [accountAttention, setAccountAttention] = useState(false)
  const [polledStatus, setPolledStatus] = useState<SessionStatus | null>(null)

  // Derived from polledStatus.authState — drives the header status dot color.
  const authStatus: AuthStatusEnum | null = polledStatus?.authState?.status ?? null
  const [bgRefreshSignal, setBgRefreshSignal] = useState(0)
  const [toolsSection, setToolsSection] = useState<string | undefined>(undefined)

  const { state, loading, error, refresh } = useAppState()

  // Speed up the poll while an auth operation is running so the header icon
  // clears promptly (within 3 s) once the lock is released.
  const activePollMs = polledStatus?.authState?.isAuthInProgress
    ? AUTH_ACTIVE_POLL_MS
    : SESSION_POLL_MS

  // ── Session status polling — derives attention dot ────────────────────────
  // Only lights up the dot for explicit known failures (DAXKO_READY and
  // FAMILYWORKS_READY are the only "clear" states). AUTH_UNKNOWN is ambiguous —
  // dot stays off. On network error: reset to false (silent fail).
  const checkSessionRef = useRef<(() => Promise<void>) | null>(null)
  useEffect(() => {
    const check = async () => {
      try {
        const status = await api.getSessionStatus()
        setPolledStatus(status)
        const needsAttention =
          !status.authState?.isAuthInProgress && (
            status.daxko === 'AUTH_NEEDS_LOGIN' ||
            status.familyworks === 'FAMILYWORKS_SESSION_MISSING'
          )
        setAccountAttention(needsAttention)
      } catch {
        // Ambiguous / unreachable — reset dot, do not alarm
        setAccountAttention(false)
      }
    }
    checkSessionRef.current = check
    check()
    const id = setInterval(check, activePollMs)
    return () => clearInterval(id)
  }, [activePollMs])

  // ── Single source of truth for the watched class ─────────────────────────
  // Stored in localStorage so it survives page reload.
  // Validated against the live job list on every refresh: if the stored ID no
  // longer exists (e.g. the job was deleted), auto-selects the first active job.
  const [selectedJobId, setSelectedJobId] = useState<number | null>(() => {
    const saved = localStorage.getItem('selectedJobId')
    return saved ? parseInt(saved, 10) : null
  })

  // When the user explicitly selects or creates a job, we pin that choice for a
  // short window so that a concurrent jobs-list refresh can't overwrite it before
  // the new job appears in the list.  The ref holds { id, until } where `until`
  // is the timestamp after which the pin expires.
  const stickySelectionRef = useRef<{ id: number; until: number } | null>(null)

  // Task #68 — sticky-on-transient-miss.
  // The polled state already retains "ghost" jobs for ~8 s via useAppState's
  // pendingDisappearance map, but a longer drift between SQLite/PG/seed-jobs
  // can still cause the watched job to vanish from state.jobs.  To prevent the
  // "card disappeared and came back" surprise reported in the Yoga Nidra bug,
  // we (a) snapshot the last-known job object whenever it appears in state,
  // (b) keep the user's selection pinned for a 12 s grace window when it goes
  // missing, and (c) hand the snapshot + a "resyncing" flag to NowScreen so
  // the hero card stays visible with a subtle banner instead of jumping to
  // the empty placeholder.
  const lastKnownJobRef = useRef<typeof state.jobs[number] | null>(null)
  const missingSinceRef = useRef<number | null>(null)
  const STICKY_MISS_GRACE_MS = 12_000

  // Snapshot the last good observation of the selected job whenever the
  // polled state contains it.  This ref drives the staleSelectedJob fallback.
  useEffect(() => {
    if (selectedJobId == null) { lastKnownJobRef.current = null; return }
    const seen = state.jobs.find(j => j.id === selectedJobId)
    if (seen) lastKnownJobRef.current = seen
  }, [state.jobs, selectedJobId])

  const [selectionResyncing, setSelectionResyncing] = useState(false)
  // Bumped from inside a setTimeout when the grace window expires, so the
  // effect below re-runs and flushes selectionResyncing even if no poll has
  // landed in the interim.
  const [graceExpiryTick, setGraceExpiryTick] = useState(0)

  useEffect(() => {
    // If we recently pinned a specific job (e.g. just after create/select) and
    // it hasn't shown up in the list yet, wait — don't fall back to a random job.
    const sticky = stickySelectionRef.current
    if (sticky && Date.now() < sticky.until && selectedJobId === sticky.id &&
        !state.jobs.some(j => j.id === selectedJobId)) {
      return
    }

    const decision = decideStickySelection({
      jobs:           state.jobs,
      selectedJobId,
      lastKnownJob:   lastKnownJobRef.current,
      missingSinceMs: missingSinceRef.current,
      nowMs:          Date.now(),
      graceWindowMs:  STICKY_MISS_GRACE_MS,
    })

    if (decision.action === 'ok') {
      missingSinceRef.current = null
      if (selectionResyncing) setSelectionResyncing(false)
      return
    }

    if (decision.action === 'resync') {
      missingSinceRef.current = decision.missingSinceMs
      if (!selectionResyncing) setSelectionResyncing(true)
      // Schedule an explicit re-check at expiry so we flush even if no
      // poll lands in the meantime.  Returning the cleanup cancels the
      // pending tick if the effect re-runs sooner.
      const remaining = decision.expiresAtMs - Date.now()
      const t = setTimeout(() => setGraceExpiryTick(n => n + 1), Math.max(50, remaining + 50))
      return () => clearTimeout(t)
    }

    // action === 'fallback'
    const newId = decision.nextSelectedId
    if (newId !== selectedJobId) {
      setSelectedJobId(newId)
      if (newId != null) localStorage.setItem('selectedJobId', String(newId))
      else localStorage.removeItem('selectedJobId')
    }
    missingSinceRef.current = null
    if (selectionResyncing) setSelectionResyncing(false)
  }, [state.jobs, selectedJobId, selectionResyncing, graceExpiryTick])

  // Snapshot used by NowScreen when the polled state misses the selection.
  // Only honoured while selectionResyncing is true so deletes still flush
  // the card after the grace window.
  const staleSelectedJob =
    selectionResyncing && lastKnownJobRef.current?.id === selectedJobId
      ? lastKnownJobRef.current
      : null


  // ── Auto-advance to Now when the watched class gets booked ────────────────
  // Detects a transition of last_result → 'booked' across polling cycles.
  // Uses two refs so switching classes or reloading never fires a false advance:
  //   watchedJobIdRef:  resets the baseline when selectedJobId changes.
  //   watchedResultRef: holds the previous result for transition detection.
  const watchedJobIdRef     = useRef<number | null>(null)
  const watchedResultRef    = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    if (selectedJobId == null) return
    const job = state.jobs.find(j => j.id === selectedJobId)
    if (!job) return

    const curr = job.last_result ?? null

    // Selected job changed — record baseline, do not navigate
    if (watchedJobIdRef.current !== selectedJobId) {
      watchedJobIdRef.current  = selectedJobId
      watchedResultRef.current = curr
      return
    }

    const prev = watchedResultRef.current

    // Transition to 'booked' from any other state → switch to Now
    if (prev !== 'booked' && curr === 'booked' && tab !== 'now') {
      setTab('now')
      localStorage.setItem('mobileTab', 'now')
    }

    watchedResultRef.current = curr
  }, [state.jobs, selectedJobId, tab])

  const handleSelectJob = (id: number) => {
    stickySelectionRef.current = { id, until: Date.now() + 300_000 }  // 5 min — covers run check duration
    setSelectedJobId(id)
    localStorage.setItem('selectedJobId', String(id))
    setTab('now')
    localStorage.setItem('mobileTab', 'now')
  }

  // Called by NowScreen when a user-initiated run check or booking starts.
  // Extends the sticky window so the selected job stays pinned for the full
  // duration of the operation instead of reverting mid-run.
  const handlePinSelection = (id: number) => {
    stickySelectionRef.current = { id, until: Date.now() + 300_000 }
  }

  const [scrolled, setScrolled] = useState(false)

  const handleTabChange = (t: Tab) => {
    setTab(t)
    localStorage.setItem('mobileTab', t)
    // Reset scroll collapse when switching tabs so the large title re-appears
    setScrolled(false)
  }

  const handleMainScroll = (e: React.UIEvent<HTMLElement>) => {
    setScrolled((e.target as HTMLElement).scrollTop > 8)
  }

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <AccountSheet
        open={accountOpen}
        onClose={() => {
          setAccountOpen(false)
          setBgRefreshSignal(v => v + 1)
          setTimeout(() => checkSessionRef.current?.(), 500)
        }}
        polledStatus={polledStatus}
      />

      <main className="flex-1 overflow-y-auto overflow-x-hidden pt-content-top" onScroll={handleMainScroll}>
        {/* Now and Plan stay mounted at all times so their local state (readiness
            scores, sniper data, countdown ticks) is preserved across tab switches.
            The active tab is shown via display; the inactive one is hidden.
            This eliminates the flicker + re-fetch that occurred on every switch. */}
        <div style={{ display: tab === 'now' ? undefined : 'none' }}>
          <NowScreen
            appState={state}
            selectedJobId={selectedJobId}
            staleSelectedJob={staleSelectedJob}
            selectionResyncing={selectionResyncing}
            loading={loading}
            error={error}
            refresh={refresh}
            onGoToTools={(section) => { setToolsSection(section); handleTabChange('tools') }}
            onAccount={() => setAccountOpen(true)}
            accountAttention={accountAttention}
            authStatus={authStatus}
            polledStatus={polledStatus}
            onDismissEscalation={async (jobId) => {
              await api.clearEscalation(jobId)
              setBgRefreshSignal(v => v + 1)
              refresh()
            }}
            bgRefreshSignal={bgRefreshSignal}
            tab={tab}
            onTabChange={handleTabChange}
            scrolled={scrolled}
            onPinSelection={handlePinSelection}
          />
        </div>
        <div style={{ display: tab === 'plan' ? undefined : 'none' }}>
          <PlanScreen
            appState={state}
            selectedJobId={selectedJobId}
            onSelectJob={handleSelectJob}
            loading={loading}
            refresh={refresh}
            onAccount={() => setAccountOpen(true)}
            accountAttention={accountAttention}
            authStatus={authStatus}
            tab={tab}
            onTabChange={handleTabChange}
            scrolled={scrolled}
          />
        </div>
        {tab === 'tools' && (
          <ToolsScreen
            appState={state}
            selectedJobId={selectedJobId}
            refresh={refresh}
            onAccount={() => setAccountOpen(true)}
            accountAttention={accountAttention}
            authStatus={authStatus}
            scrollTo={toolsSection}
            tab={tab}
            onTabChange={handleTabChange}
            scrolled={scrolled}
          />
        )}
        {tab === 'settings' && (
          <SettingsScreen
            appState={state}
            refresh={refresh}
            onSessionRefresh={() => checkSessionRef.current?.()}
            onAccount={() => setAccountOpen(true)}
            accountAttention={accountAttention}
            authStatus={authStatus}
            tab={tab}
            onTabChange={handleTabChange}
            scrolled={scrolled}
          />
        )}
      </main>
    </div>
  )
}

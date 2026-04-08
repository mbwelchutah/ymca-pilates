import { useState, useEffect, useRef } from 'react'
import { TabBar } from './components/nav/TabBar'
import type { Tab } from './components/nav/TabBar'
import { NowScreen } from './screens/NowScreen'
import { PlanScreen } from './screens/PlanScreen'
import { ToolsScreen } from './screens/ToolsScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { AccountSheet } from './components/AccountSheet'
import { useAppState } from './hooks/useAppState'
import { api } from './lib/api'
import type { SessionStatus, AuthStatusEnum } from './types'

const SESSION_POLL_MS = 90 * 1000  // 90 s — fast enough to settle stale auth dot after background ops

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
  const [autoVerifySignal, setAutoVerifySignal] = useState(0)
  const [toolsSection, setToolsSection] = useState<string | undefined>(undefined)
  const startupVerified = useRef(false)

  const { state, loading, error, refresh } = useAppState()

  // ── Session status polling — derives attention dot ────────────────────────
  // Only lights up the dot for explicit known failures (DAXKO_READY and
  // FAMILYWORKS_READY are the only "clear" states). AUTH_UNKNOWN is ambiguous —
  // dot stays off. On network error: reset to false (silent fail).
  useEffect(() => {
    const check = async () => {
      try {
        const status = await api.getSessionStatus()
        setPolledStatus(status)
        const needsAttention =
          status.daxko === 'AUTH_NEEDS_LOGIN' ||
          status.familyworks === 'FAMILYWORKS_SESSION_MISSING'
        setAccountAttention(needsAttention)
      } catch {
        // Ambiguous / unreachable — reset dot, do not alarm
        setAccountAttention(false)
      }
    }
    check()
    const id = setInterval(check, SESSION_POLL_MS)
    return () => clearInterval(id)
  }, [])

  // ── Single source of truth for the watched class ─────────────────────────
  // Stored in localStorage so it survives page reload.
  // Validated against the live job list on every refresh: if the stored ID no
  // longer exists (e.g. the job was deleted), auto-selects the first active job.
  const [selectedJobId, setSelectedJobId] = useState<number | null>(() => {
    const saved = localStorage.getItem('selectedJobId')
    return saved ? parseInt(saved, 10) : null
  })

  useEffect(() => {
    if (state.jobs.length === 0) return
    const isValid = selectedJobId !== null && state.jobs.some(j => j.id === selectedJobId)
    if (!isValid) {
      const fallback = state.jobs.find(j => j.is_active) ?? state.jobs[0]
      const newId = fallback?.id ?? null
      if (newId !== selectedJobId) {
        setSelectedJobId(newId)
        if (newId != null) localStorage.setItem('selectedJobId', String(newId))
        else localStorage.removeItem('selectedJobId')
      }
    }
  }, [state.jobs, selectedJobId])

  // ── Auto-verify on startup ────────────────────────────────────────────────
  // Fires once, as soon as we have a valid job loaded, to check class readiness
  // immediately without the user having to tap "Verify".
  useEffect(() => {
    if (loading || startupVerified.current) return
    if (selectedJobId == null || !state.jobs.some(j => j.id === selectedJobId)) return
    startupVerified.current = true
    setAutoVerifySignal(s => s + 1)
  }, [loading, selectedJobId, state.jobs])

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
    setSelectedJobId(id)
    localStorage.setItem('selectedJobId', String(id))
    setTab('now')
    localStorage.setItem('mobileTab', 'now')
    // Verify the newly selected class automatically
    setAutoVerifySignal(s => s + 1)
  }

  const handleTabChange = (t: Tab) => {
    setTab(t)
    localStorage.setItem('mobileTab', t)
  }

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <AccountSheet open={accountOpen} onClose={() => setAccountOpen(false)} polledStatus={polledStatus} />
      <TabBar active={tab} onChange={handleTabChange} />

      <main className="flex-1 overflow-y-auto pt-content-top">
        {/* Now and Plan stay mounted at all times so their local state (readiness
            scores, sniper data, countdown ticks) is preserved across tab switches.
            The active tab is shown via display; the inactive one is hidden.
            This eliminates the flicker + re-fetch that occurred on every switch. */}
        <div style={{ display: tab === 'now' ? undefined : 'none' }}>
          <NowScreen
            appState={state}
            selectedJobId={selectedJobId}
            loading={loading}
            error={error}
            refresh={refresh}
            onGoToTools={(section) => { setToolsSection(section); handleTabChange('tools') }}
            onAccount={() => setAccountOpen(true)}
            accountAttention={accountAttention}
            authStatus={authStatus}
            autoVerifySignal={autoVerifySignal}
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
          />
        </div>
        {tab === 'tools' && (
          <ToolsScreen appState={state} selectedJobId={selectedJobId} refresh={refresh} onAccount={() => setAccountOpen(true)} accountAttention={accountAttention} authStatus={authStatus} scrollTo={toolsSection} />
        )}
        {tab === 'settings' && (
          <SettingsScreen appState={state} refresh={refresh} onAccount={() => setAccountOpen(true)} accountAttention={accountAttention} authStatus={authStatus} />
        )}
      </main>
    </div>
  )
}

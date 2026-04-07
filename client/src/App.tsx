import { useState, useEffect } from 'react'
import { TabBar } from './components/nav/TabBar'
import type { Tab } from './components/nav/TabBar'
import { NowScreen } from './screens/NowScreen'
import { PlanScreen } from './screens/PlanScreen'
import { ToolsScreen } from './screens/ToolsScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { AccountSheet } from './components/AccountSheet'
import { useAppState } from './hooks/useAppState'
import { api } from './lib/api'
import type { SessionStatus } from './types'

const SESSION_POLL_MS = 5 * 60 * 1000  // 5 minutes

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const saved = localStorage.getItem('mobileTab')
    return (saved === 'now' || saved === 'plan' || saved === 'tools' || saved === 'settings') ? saved : 'now'
  })

  const [accountOpen, setAccountOpen] = useState(false)
  const [accountAttention, setAccountAttention] = useState(false)
  const [polledStatus, setPolledStatus] = useState<SessionStatus | null>(null)

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

  const handleSelectJob = (id: number) => {
    setSelectedJobId(id)
    localStorage.setItem('selectedJobId', String(id))
    setTab('now')
    localStorage.setItem('mobileTab', 'now')
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
        {tab === 'now' && (
          <NowScreen
            appState={state}
            selectedJobId={selectedJobId}
            loading={loading}
            error={error}
            refresh={refresh}
            onGoToTools={() => handleTabChange('tools')}
            onAccount={() => setAccountOpen(true)}
            accountAttention={accountAttention}
          />
        )}
        {tab === 'plan' && (
          <PlanScreen
            appState={state}
            selectedJobId={selectedJobId}
            onSelectJob={handleSelectJob}
            loading={loading}
            refresh={refresh}
            onAccount={() => setAccountOpen(true)}
            accountAttention={accountAttention}
          />
        )}
        {tab === 'tools' && (
          <ToolsScreen appState={state} selectedJobId={selectedJobId} refresh={refresh} onAccount={() => setAccountOpen(true)} accountAttention={accountAttention} />
        )}
        {tab === 'settings' && (
          <SettingsScreen appState={state} refresh={refresh} onAccount={() => setAccountOpen(true)} accountAttention={accountAttention} />
        )}
      </main>
    </div>
  )
}

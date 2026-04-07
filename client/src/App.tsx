import { useState, useEffect } from 'react'
import { TabBar } from './components/nav/TabBar'
import type { Tab } from './components/nav/TabBar'
import { NowScreen } from './screens/NowScreen'
import { PlanScreen } from './screens/PlanScreen'
import { ToolsScreen } from './screens/ToolsScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { useAppState } from './hooks/useAppState'

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const saved = localStorage.getItem('mobileTab')
    return (saved === 'now' || saved === 'plan' || saved === 'tools' || saved === 'settings') ? saved : 'now'
  })

  const [accountOpen, setAccountOpen] = useState(false)

  const { state, loading, error, refresh } = useAppState()

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
          />
        )}
        {tab === 'tools' && (
          <ToolsScreen appState={state} selectedJobId={selectedJobId} refresh={refresh} onAccount={() => setAccountOpen(true)} />
        )}
        {tab === 'settings' && (
          <SettingsScreen appState={state} refresh={refresh} onAccount={() => setAccountOpen(true)} />
        )}
      </main>
    </div>
  )
}

import { useState } from 'react'
import { TabBar } from './components/nav/TabBar'
import type { Tab } from './components/nav/TabBar'
import { NowScreen } from './screens/NowScreen'
import { PlanScreen } from './screens/PlanScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { useAppState } from './hooks/useAppState'

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const saved = localStorage.getItem('mobileTab')
    return (saved === 'now' || saved === 'plan' || saved === 'settings') ? saved : 'now'
  })

  const { state, loading, error, refresh } = useAppState()

  // Client-side job selection persisted in localStorage.
  // Falls back to the backend's first-active job when not yet set.
  const [clientSelectedJobId, setClientSelectedJobId] = useState<number | null>(() => {
    const saved = localStorage.getItem('selectedJobId')
    return saved ? parseInt(saved, 10) : null
  })

  const handleSelectJob = (id: number) => {
    setClientSelectedJobId(id)
    localStorage.setItem('selectedJobId', String(id))
  }

  const effectiveSelectedJobId = clientSelectedJobId ?? state.selectedJobId

  const handleTabChange = (t: Tab) => {
    setTab(t)
    localStorage.setItem('mobileTab', t)
  }

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <main className="flex-1 overflow-y-auto">
        {tab === 'now' && (
          <NowScreen
            appState={state}
            selectedJobId={effectiveSelectedJobId}
            loading={loading}
            error={error}
            refresh={refresh}
          />
        )}
        {tab === 'plan' && (
          <PlanScreen
            appState={state}
            selectedJobId={effectiveSelectedJobId}
            onSelectJob={handleSelectJob}
            loading={loading}
            refresh={refresh}
          />
        )}
        {tab === 'settings' && (
          <SettingsScreen appState={state} refresh={refresh} />
        )}
      </main>

      <TabBar active={tab} onChange={handleTabChange} />
    </div>
  )
}

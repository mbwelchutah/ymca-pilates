import { useState } from 'react'
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

  const { state, loading, error, refresh } = useAppState()

  const [clientSelectedJobId, setClientSelectedJobId] = useState<number | null>(() => {
    const saved = localStorage.getItem('selectedJobId')
    return saved ? parseInt(saved, 10) : null
  })

  const handleSelectJob = (id: number) => {
    setClientSelectedJobId(id)
    localStorage.setItem('selectedJobId', String(id))
    setTab('now')
    localStorage.setItem('mobileTab', 'now')
  }

  const effectiveSelectedJobId = clientSelectedJobId ?? state.selectedJobId

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
        {tab === 'tools' && (
          <ToolsScreen appState={state} selectedJobId={effectiveSelectedJobId} refresh={refresh} />
        )}
        {tab === 'settings' && (
          <SettingsScreen appState={state} refresh={refresh} />
        )}
      </main>
    </div>
  )
}

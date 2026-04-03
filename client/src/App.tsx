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

  const handleTabChange = (t: Tab) => {
    setTab(t)
    localStorage.setItem('mobileTab', t)
  }

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      {/* Screen content */}
      <main className="flex-1 overflow-y-auto">
        {tab === 'now' && (
          <NowScreen appState={state} loading={loading} error={error} refresh={refresh} />
        )}
        {tab === 'plan' && (
          <PlanScreen appState={state} loading={loading} refresh={refresh} />
        )}
        {tab === 'settings' && (
          <SettingsScreen appState={state} refresh={refresh} />
        )}
      </main>

      {/* Bottom tab bar */}
      <TabBar active={tab} onChange={handleTabChange} />
    </div>
  )
}

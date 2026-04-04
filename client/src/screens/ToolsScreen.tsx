import { AppHeader } from '../components/layout/AppHeader'
import { ScreenContainer } from '../components/layout/ScreenContainer'
import { SectionHeader } from '../components/layout/SectionHeader'
import { Card } from '../components/ui/Card'
import type { AppState } from '../types'

interface ToolsScreenProps {
  appState: AppState
  refresh: () => void
}

export function ToolsScreen({ appState: _appState, refresh: _refresh }: ToolsScreenProps) {
  return (
    <>
      <AppHeader subtitle="Diagnostics" />
      <ScreenContainer>
        <SectionHeader title="Playwright" />
        <Card>
          <div className="px-4 py-3">
            <p className="text-[13px] text-text-secondary">
              Playwright diagnostics coming soon — session health, last run metadata, browser context status.
            </p>
          </div>
        </Card>

        <SectionHeader title="Failure Summary" />
        <Card>
          <div className="px-4 py-3">
            <p className="text-[13px] text-text-secondary">
              Booking failure tallies and recent failure log coming soon.
            </p>
          </div>
        </Card>

        <SectionHeader title="Screenshots" />
        <Card>
          <div className="px-4 py-3">
            <p className="text-[13px] text-text-secondary">
              Failure screenshots coming soon.
            </p>
          </div>
        </Card>

        <SectionHeader title="Debug Actions" />
        <Card>
          <div className="px-4 py-3">
            <p className="text-[13px] text-text-secondary">
              Manual run triggers and debug utilities coming soon.
            </p>
          </div>
        </Card>
      </ScreenContainer>
    </>
  )
}

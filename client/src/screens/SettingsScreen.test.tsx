// @vitest-environment jsdom
//
// Task #90 — staleness pill + inline toggle-error coverage for the
// Settings screen.  Verifies that:
//   * StaleStatePill renders when meta.degradedReason is set, when
//     meta.fallbackJobId is true, when pollFailed is true, and when the
//     snapshot is older than the 5-minute staleness threshold.
//   * The pause/dry-run toggles surface the inline
//     "Couldn't reach server — try again" row when their API call rejects.
//   * The inline error row auto-clears after the documented ~4s timeout.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import { SettingsScreen } from './SettingsScreen'
import type { AppState } from '../types'

vi.mock('../lib/api', () => ({
  api: {
    setDryRun:        vi.fn(),
    pauseScheduler:   vi.fn(),
    resumeScheduler:  vi.fn(),
    settingsClear:    vi.fn(),
  },
}))
import { api } from '../lib/api'

function buildAppState(overrides: Partial<AppState> = {}): AppState {
  return {
    schedulerPaused: false,
    dryRun:          false,
    jobs:            [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('SettingsScreen — StaleStatePill visibility (Task #81/#90)', () => {
  it('hides the pill when nothing is stale', () => {
    render(<SettingsScreen appState={buildAppState()} refresh={() => {}} />)
    expect(screen.queryByTestId('stale-state-pill')).toBeNull()
  })

  it('shows the pill when pollFailed=true', () => {
    render(<SettingsScreen appState={buildAppState()} refresh={() => {}} pollFailed />)
    expect(screen.getByTestId('stale-state-pill')).toBeTruthy()
  })

  it('shows the pill when meta.degradedReason is set', () => {
    const appState = buildAppState({
      meta: { degradedReason: 'past_jobs_inactivated', fallbackJobId: false, snapshotAge: null },
    })
    render(<SettingsScreen appState={appState} refresh={() => {}} />)
    expect(screen.getByTestId('stale-state-pill')).toBeTruthy()
  })

  it('shows the pill when meta.fallbackJobId is true', () => {
    const appState = buildAppState({
      meta: { degradedReason: null, fallbackJobId: true, snapshotAge: null },
    })
    render(<SettingsScreen appState={appState} refresh={() => {}} />)
    expect(screen.getByTestId('stale-state-pill')).toBeTruthy()
  })

  it('shows the pill when meta.snapshotAge exceeds the 5-minute threshold', () => {
    const appState = buildAppState({
      meta: { degradedReason: null, fallbackJobId: false, snapshotAge: 6 * 60 * 1000 },
    })
    render(<SettingsScreen appState={appState} refresh={() => {}} />)
    expect(screen.getByTestId('stale-state-pill')).toBeTruthy()
  })
})

describe('SettingsScreen — inline toggle errors (Task #81/#90)', () => {
  it('shows the inline "Couldn\'t reach server — try again" row when the dry-run toggle fails, and clears after ~4s', async () => {
    vi.useFakeTimers()
    ;(api.setDryRun as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))

    render(<SettingsScreen appState={buildAppState()} refresh={() => {}} />)

    // Click the simulation-mode (dry run) switch.  It's the second switch in
    // the Scheduler card — pause is first.
    const switches = screen.getAllByRole('switch')
    expect(switches.length).toBeGreaterThanOrEqual(2)
    fireEvent.click(switches[1])

    // Allow the rejected promise microtask to surface the error row.
    await act(async () => { await Promise.resolve() })

    const err = screen.getByTestId('dryrun-error')
    expect(err.textContent).toContain("Couldn't reach server")

    // Auto-clear timer fires at 4s.
    await act(async () => { vi.advanceTimersByTime(4000) })
    expect(screen.queryByTestId('dryrun-error')).toBeNull()
  })

  it('shows the inline "Couldn\'t reach server — try again" row when the pause toggle fails, and clears after ~4s', async () => {
    vi.useFakeTimers()
    ;(api.pauseScheduler as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))

    render(<SettingsScreen appState={buildAppState()} refresh={() => {}} />)

    const pauseSwitch = screen.getAllByRole('switch')[0]
    fireEvent.click(pauseSwitch)

    await act(async () => { await Promise.resolve() })

    const err = screen.getByTestId('pause-error')
    expect(err.textContent).toContain("Couldn't reach server")

    await act(async () => { vi.advanceTimersByTime(4000) })
    expect(screen.queryByTestId('pause-error')).toBeNull()
  })

  it('does not surface an inline error row on a successful toggle', async () => {
    ;(api.setDryRun as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })
    render(<SettingsScreen appState={buildAppState()} refresh={() => {}} />)

    const switches = screen.getAllByRole('switch')
    fireEvent.click(switches[1])

    await act(async () => { await Promise.resolve() })

    expect(screen.queryByTestId('dryrun-error')).toBeNull()
  })
})

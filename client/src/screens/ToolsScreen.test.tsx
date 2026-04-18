// @vitest-environment jsdom
//
// Task #90 — staleness pill + inline toggle-error coverage for the
// Tools screen.  Verifies that:
//   * StaleStatePill renders when pollFailed is true, when appState.meta
//     reports a degraded reason, and when one of the four tracked endpoints
//     fails to load.
//   * The Auto Preflight, Session Check, and Clear-failures controls each
//     surface the inline "Couldn't reach server — try again" row when their
//     API call rejects, and clear that row after the documented ~4s timeout.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import type { AppState } from '../types'

// ── api mock ──────────────────────────────────────────────────────────────
// Defaults match the "healthy, never-loaded" UI paths so the screen renders
// without throwing.  Individual tests override specific calls to drive the
// failure-mode rendering paths under test.
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ...actual,
    api: {
      getFailures: vi.fn().mockResolvedValue({
        recent: [], summary: {}, by_phase: {},
        trends: { h1: { byReason: [], byPhase: [], total: 0 },
                  h6: { byReason: [], byPhase: [], total: 0 },
                  h24:{ byReason: [], byPhase: [], total: 0 },
                  d7: { byReason: [], byPhase: [], total: 0 } },
        byJob: [], hideBefore: null,
      }),
      getStatus:                   vi.fn().mockResolvedValue({ active: false, log: '', success: null }),
      getSessionStatus:            vi.fn().mockResolvedValue(null),
      getSniperState:              vi.fn().mockResolvedValue(null),
      getAutoPreflightConfig:      vi.fn().mockResolvedValue({ enabled: false, lastRun: null, nextTrigger: null }),
      getSessionKeepaliveConfig:   vi.fn().mockResolvedValue({ enabled: false, intervalMinutes: 30, intervalHours: 0.5, lastRun: null, next: null }),
      getReadiness:                vi.fn().mockResolvedValue(null),
      classifyJob:                 vi.fn().mockResolvedValue(null),
      getConfirmedReady:           vi.fn().mockResolvedValue(null),
      setAutoPreflightEnabled:     vi.fn(),
      setSessionKeepaliveConfig:   vi.fn(),
      clearFailures:               vi.fn(),
    },
  }
})

import { ToolsScreen } from './ToolsScreen'
import { api } from '../lib/api'

function buildAppState(overrides: Partial<AppState> = {}): AppState {
  return {
    schedulerPaused: false,
    dryRun:          false,
    jobs:            [],
    ...overrides,
  }
}

// flushPromises — drain pending microtasks so useEffect-triggered fetch
// resolutions are reflected in rendered output before assertions.
async function flushPromises(times = 5) {
  for (let i = 0; i < times; i++) {
    await act(async () => { await Promise.resolve() })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ToolsScreen — StaleStatePill visibility (Task #81/#90)', () => {
  it('hides the pill when no staleness signal is set', async () => {
    render(<ToolsScreen appState={buildAppState()} selectedJobId={null} refresh={() => {}} />)
    await flushPromises()
    expect(screen.queryByTestId('stale-state-pill')).toBeNull()
  })

  it('shows the pill when pollFailed=true', async () => {
    render(<ToolsScreen appState={buildAppState()} selectedJobId={null} refresh={() => {}} pollFailed />)
    await flushPromises()
    expect(screen.getByTestId('stale-state-pill')).toBeTruthy()
  })

  it('shows the pill when appState.meta.degradedReason is set', async () => {
    const appState = buildAppState({
      meta: { degradedReason: 'past_jobs_inactivated', fallbackJobId: false, snapshotAge: null },
    })
    render(<ToolsScreen appState={appState} selectedJobId={null} refresh={() => {}} />)
    await flushPromises()
    expect(screen.getByTestId('stale-state-pill')).toBeTruthy()
  })

  it('shows the pill when appState.meta.fallbackJobId is true', async () => {
    const appState = buildAppState({
      meta: { degradedReason: null, fallbackJobId: true, snapshotAge: null },
    })
    render(<ToolsScreen appState={appState} selectedJobId={null} refresh={() => {}} />)
    await flushPromises()
    expect(screen.getByTestId('stale-state-pill')).toBeTruthy()
  })

  it('shows the pill when one of the four tracked endpoints rejects (sessionStatus)', async () => {
    ;(api.getSessionStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('net'))
    render(<ToolsScreen appState={buildAppState()} selectedJobId={null} refresh={() => {}} />)
    await flushPromises()
    expect(screen.getByTestId('stale-state-pill')).toBeTruthy()
  })

  it('shows the pill when /api/readiness rejects', async () => {
    ;(api.getReadiness as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('net'))
    render(<ToolsScreen appState={buildAppState()} selectedJobId={null} refresh={() => {}} />)
    await flushPromises()
    expect(screen.getByTestId('stale-state-pill')).toBeTruthy()
  })

  it('shows the pill when sessionStatus.meta.degradedReason is set', async () => {
    ;(api.getSessionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      valid: null, checkedAt: null, detail: null, screenshot: null,
      daxko: 'AUTH_UNKNOWN', familyworks: 'AUTH_UNKNOWN', overall: 'AUTH_UNKNOWN',
      lastVerified: null,
      meta: { degradedReason: 'no_session_check_yet', fallbackJobId: false, snapshotAge: null },
    })
    render(<ToolsScreen appState={buildAppState()} selectedJobId={null} refresh={() => {}} />)
    await flushPromises()
    expect(screen.getByTestId('stale-state-pill')).toBeTruthy()
  })
})

describe('ToolsScreen — inline toggle errors (Task #81/#90)', () => {
  it('shows + auto-clears the auto-preflight inline error after ~4s on failure', async () => {
    ;(api.getAutoPreflightConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      enabled: false, lastRun: null, nextTrigger: null,
    })
    ;(api.setAutoPreflightEnabled as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))

    render(<ToolsScreen appState={buildAppState()} selectedJobId={null} refresh={() => {}} />)
    await flushPromises()

    // The Auto Preflight row is the first toggle button containing "Auto Preflight".
    const apfButton = screen.getByText(/Auto Preflight/i).closest('button')!
    expect(apfButton).toBeTruthy()

    vi.useFakeTimers()
    fireEvent.click(apfButton)
    await flushPromises()

    expect(screen.getByTestId('apf-error').textContent).toContain("Couldn't reach server")

    await act(async () => { vi.advanceTimersByTime(4000) })
    expect(screen.queryByTestId('apf-error')).toBeNull()
  })

  it('shows + auto-clears the session-keepalive inline error after ~4s on failure', async () => {
    ;(api.setSessionKeepaliveConfig as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))

    render(<ToolsScreen appState={buildAppState()} selectedJobId={null} refresh={() => {}} />)
    await flushPromises()

    const kaButton = screen.getByText(/Session Check/i).closest('button')!
    expect(kaButton).toBeTruthy()

    vi.useFakeTimers()
    fireEvent.click(kaButton)
    await flushPromises()

    expect(screen.getByTestId('ka-error').textContent).toContain("Couldn't reach server")

    await act(async () => { vi.advanceTimersByTime(4000) })
    expect(screen.queryByTestId('ka-error')).toBeNull()
  })

  it('shows + auto-clears the clear-failures inline error after ~4s on failure', async () => {
    // Render Recent Failures by returning a non-empty list so the
    // "Clear history" action surfaces in the header.
    ;(api.getFailures as ReturnType<typeof vi.fn>).mockResolvedValue({
      recent: [{
        id: 1, job_id: null, occurred_at: new Date().toISOString(),
        phase: 'system', reason: 'unexpected_error', message: 'boom',
        class_title: null, screenshot: null, category: null, label: null,
        expected: null, actual: null, url: null, context_json: null,
      }],
      summary: {}, by_phase: {},
      trends: { h1: { byReason: [], byPhase: [], total: 0 },
                h6: { byReason: [], byPhase: [], total: 0 },
                h24:{ byReason: [], byPhase: [], total: 0 },
                d7: { byReason: [], byPhase: [], total: 0 } },
      byJob: [], hideBefore: null,
    })
    ;(api.clearFailures as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))

    render(<ToolsScreen appState={buildAppState()} selectedJobId={null} refresh={() => {}} />)
    await flushPromises()

    // First click arms the confirm; the second click triggers the API call.
    const clearBtn = screen.getByText(/Clear history/i)
    fireEvent.click(clearBtn)
    await flushPromises()
    const confirmBtn = screen.getByText(/Tap again to confirm/i)

    vi.useFakeTimers()
    fireEvent.click(confirmBtn)
    await flushPromises()

    expect(screen.getByTestId('clear-failures-error').textContent).toContain("Couldn't reach server")

    await act(async () => { vi.advanceTimersByTime(4000) })
    expect(screen.queryByTestId('clear-failures-error')).toBeNull()
  })
})

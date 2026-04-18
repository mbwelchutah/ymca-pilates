// @vitest-environment jsdom
//
// Task #90 — covers the inline session-load failure indicator in the
// account sheet.  When /api/session-status rejects, the sheet shows an
// inline "Couldn't load session — tap to retry" button instead of silently
// reverting to the "Checking…" headline.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'

vi.mock('../lib/api', () => ({
  api: {
    getSessionStatus: vi.fn(),
    settingsLogin:    vi.fn(),
    settingsRefresh:  vi.fn(),
    settingsClear:    vi.fn(),
  },
}))

import { AccountSheet } from './AccountSheet'
import { api } from '../lib/api'

async function flushPromises(times = 4) {
  for (let i = 0; i < times; i++) {
    await act(async () => { await Promise.resolve() })
  }
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup() })

describe('AccountSheet — session-status load failure (Task #81/#90)', () => {
  it('shows the tap-to-retry inline error when getSessionStatus rejects', async () => {
    ;(api.getSessionStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('net'))
    render(<AccountSheet open={true} onClose={() => {}} />)
    await flushPromises()
    expect(screen.getByTestId('session-load-error')).toBeTruthy()
  })

  it('does not show the error when getSessionStatus resolves', async () => {
    ;(api.getSessionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      valid: true, checkedAt: null, detail: null, screenshot: null,
      daxko: 'DAXKO_READY', familyworks: 'FAMILYWORKS_READY', overall: 'DAXKO_READY',
      lastVerified: null,
    })
    render(<AccountSheet open={true} onClose={() => {}} />)
    await flushPromises()
    expect(screen.queryByTestId('session-load-error')).toBeNull()
  })

  it('clears the error after a successful tap-to-retry', async () => {
    const fn = api.getSessionStatus as ReturnType<typeof vi.fn>
    fn.mockRejectedValueOnce(new Error('net'))
    fn.mockResolvedValueOnce({
      valid: true, checkedAt: null, detail: null, screenshot: null,
      daxko: 'DAXKO_READY', familyworks: 'FAMILYWORKS_READY', overall: 'DAXKO_READY',
      lastVerified: null,
    })
    render(<AccountSheet open={true} onClose={() => {}} />)
    await flushPromises()
    const retry = screen.getByTestId('session-load-error')
    fireEvent.click(retry)
    await flushPromises()
    expect(screen.queryByTestId('session-load-error')).toBeNull()
  })
})

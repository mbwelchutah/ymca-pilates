// @vitest-environment jsdom
//
// Task #90 — pill rendering coverage.  Verifies that the
// StaleStatePill component renders with the expected stable testid, shows the
// "Showing last known state" copy, and humanises the optional ageSeconds suffix.

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { StaleStatePill } from './StaleStatePill'

afterEach(cleanup)

describe('StaleStatePill', () => {
  it('renders the testid + headline copy when given no props', () => {
    render(<StaleStatePill />)
    const pill = screen.getByTestId('stale-state-pill')
    expect(pill).toBeTruthy()
    expect(pill.textContent).toContain('Showing last known state')
    expect(pill.textContent).not.toContain('·')
  })

  it('appends a humanised "just now" suffix for sub-5s ages', () => {
    render(<StaleStatePill ageSeconds={2} />)
    expect(screen.getByTestId('stale-state-pill').textContent).toContain('just now')
  })

  it('appends a seconds-ago suffix for ages under one minute', () => {
    render(<StaleStatePill ageSeconds={42} />)
    expect(screen.getByTestId('stale-state-pill').textContent).toContain('42s ago')
  })

  it('appends a minutes-ago suffix for ages over a minute', () => {
    render(<StaleStatePill ageSeconds={125} />)
    expect(screen.getByTestId('stale-state-pill').textContent).toContain('2m ago')
  })

  it('appends the supplied reason after the age suffix', () => {
    render(<StaleStatePill ageSeconds={10} reason="past_jobs_inactivated" />)
    const txt = screen.getByTestId('stale-state-pill').textContent ?? ''
    expect(txt).toContain('10s ago')
    expect(txt).toContain('past_jobs_inactivated')
  })

  it('omits the age suffix when ageSeconds is null/undefined', () => {
    render(<StaleStatePill reason="r" />)
    const txt = screen.getByTestId('stale-state-pill').textContent ?? ''
    expect(txt).toContain('r')
    expect(txt).not.toMatch(/ago/)
  })
})

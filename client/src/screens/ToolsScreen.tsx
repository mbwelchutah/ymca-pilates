import { useEffect, useState } from 'react'
import { AppHeader } from '../components/layout/AppHeader'
import { ScreenContainer } from '../components/layout/ScreenContainer'
import { SectionHeader } from '../components/layout/SectionHeader'
import { Card } from '../components/ui/Card'
import { DetailRow } from '../components/ui/DetailRow'
import type { AppState } from '../types'
import { api } from '../lib/api'

interface FailureEntry {
  id:          number | null
  job_id:      number | null
  occurred_at: string
  phase:       string
  reason:      string
  message:     string | null
  class_title: string | null
  screenshot:  string | null
}

interface FailureData {
  recent:   FailureEntry[]
  summary:  Record<string, number>
  by_phase: Record<string, number>
}

interface SessionStatus {
  active: boolean
  log: string
  success: boolean | null
}

interface ToolsScreenProps {
  appState: AppState
  selectedJobId: number | null
  refresh: () => void
}

const REASON_LABELS: Record<string, string> = {
  'invalid_job_params':          'Invalid job parameters',
  'login_failed':                'Login failed',
  'session_expired':             'Session expired',
  'filter_apply_failed':         'Filters failed to apply',
  'schedule_not_rendered':       'Schedule rendered empty',
  'class_not_found':             'Class not on schedule',
  'modal_time_mismatch':         'Modal — wrong time',
  'modal_instructor_mismatch':   'Modal — wrong instructor',
  'modal_mismatch':              'Modal — wrong time & instructor',
  'click_fallback':              'Click failed — force used',
  'booking_not_open':            'Booking not open yet',
  'registration_unclear':        'No confirmation after click',
  'stale_card_recovery_failed':  'Card lost after reload',
  'unexpected_error':            'Unexpected error',
}

const PHASE_LABELS: Record<string, string> = {
  // Current taxonomy
  'system':      'System',
  'auth':        'Auth / Session',
  'navigate':    'Navigation',
  'scan':        'Schedule scan',
  'verify':      'Identity verify',
  'click':       'Card click',
  'gate':        'Booking gate',
  'action':      'Booking action',
  'post_click':  'Post-click check',
  'recovery':    'Stale recovery',
  // Legacy taxonomy (kept for any pre-migration rows)
  'login':          'Login',
  'schedule_scan':  'Schedule scan',
  'card_click':     'Card click',
  'modal_verify':   'Modal verify',
  'booking':        'Booking',
  'unknown':        'Unknown',
}

const RESULT_LABELS: Record<string, string> = {
  booked:             'Booked',
  dry_run:            'Simulated Booking',
  found_not_open_yet: 'Not Open Yet',
  not_found:          'Class Not Found',
  error:              'Error',
  skipped:            'Skipped',
}

const fmtStr = (s: string) =>
  new Date(s).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

function ChevronIcon({ rotated }: { rotated: boolean }) {
  return (
    <svg
      width="8" height="13" viewBox="0 0 8 13" fill="none"
      className={`text-text-muted flex-shrink-0 transition-transform ${rotated ? 'rotate-90' : ''}`}
    >
      <path d="M1 1l6 5.5L1 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ActionRow({
  label, detail, onClick, loading, disabled,
}: {
  label: string
  detail?: string
  onClick: () => void
  loading?: boolean
  disabled?: boolean
}) {
  return (
    <button
      disabled={loading || disabled}
      onClick={onClick}
      className={`flex items-center justify-between w-full px-4 py-3.5 text-left transition-opacity ${disabled ? 'opacity-40' : 'active:opacity-60'}`}
    >
      <div className="flex-1 mr-4">
        <p className={`text-[15px] font-medium ${disabled ? 'text-text-secondary' : 'text-accent-blue'}`}>
          {loading ? 'Running…' : label}
        </p>
        {detail && <p className="text-[12px] text-text-secondary mt-0.5">{detail}</p>}
      </div>
      <ChevronIcon rotated={false} />
    </button>
  )
}

export function ToolsScreen({ appState, selectedJobId, refresh }: ToolsScreenProps) {
  const selectedJob = appState.jobs.find(j => j.id === selectedJobId) ?? appState.jobs[0] ?? null

  const [failures, setFailures] = useState<FailureData | null>(null)
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(null)
  const [expandedShot, setExpandedShot] = useState<string | null>(null)
  const [forceLoading, setForceLoading] = useState(false)
  const [forceMsg, setForceMsg] = useState<string | null>(null)
  const [runOnceLoading, setRunOnceLoading] = useState(false)
  const [runOnceMsg, setRunOnceMsg] = useState<string | null>(null)

  useEffect(() => {
    api.getFailures().then(setFailures).catch(() => {})
    api.getStatus().then(setSessionStatus).catch(() => {})
  }, [])

  const lastRunJob = [...appState.jobs]
    .filter(j => j.last_run_at)
    .sort((a, b) => new Date(b.last_run_at!).getTime() - new Date(a.last_run_at!).getTime())[0] ?? null

  const handleForce = async () => {
    if (!selectedJob) return
    setForceLoading(true)
    setForceMsg(null)
    try {
      const r = await api.forceRunJob(selectedJob.id)
      setForceMsg(r.message)
      refresh()
    } catch (e) {
      setForceMsg(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setForceLoading(false)
    }
  }

  const handleRunOnce = async () => {
    setRunOnceLoading(true)
    setRunOnceMsg(null)
    try {
      const r = await api.runSchedulerOnce()
      setRunOnceMsg(r.message)
      refresh()
    } catch (e) {
      setRunOnceMsg(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setRunOnceLoading(false)
    }
  }

  const failureEntries = Object.entries(failures?.summary ?? {})
    .sort((a, b) => b[1] - a[1])
  const recentFailures = failures?.recent ?? []

  return (
    <>
      <AppHeader subtitle="Diagnostics" />
      <ScreenContainer>

        {/* ── 1. Playwright ──────────────────────────────────── */}
        <SectionHeader title="Playwright" />
        <Card padding="none">
          <DetailRow
            label="Session"
            value={sessionStatus == null ? 'Loading…' : sessionStatus.active ? 'Running' : 'Idle'}
          />
          {lastRunJob ? (
            <>
              <DetailRow
                label="Last Run"
                value={lastRunJob.last_run_at ? fmtStr(lastRunJob.last_run_at) : '—'}
              />
              <DetailRow
                label="Job"
                value={`#${lastRunJob.id} — ${lastRunJob.class_title}`}
              />
              <DetailRow
                label="Result"
                value={lastRunJob.last_result ? (RESULT_LABELS[lastRunJob.last_result] ?? lastRunJob.last_result) : '—'}
                last={!lastRunJob.last_error_message}
              />
              {lastRunJob.last_error_message && (
                <DetailRow
                  label="Error"
                  value={
                    lastRunJob.last_error_message.length > 60
                      ? lastRunJob.last_error_message.slice(0, 60) + '…'
                      : lastRunJob.last_error_message
                  }
                  last
                />
              )}
            </>
          ) : (
            <DetailRow label="Last Run" value="No runs yet" last />
          )}
        </Card>
        {sessionStatus?.log && (
          <Card padding="sm" className="bg-surface border border-divider shadow-none">
            <p className="text-[11px] font-mono text-text-secondary leading-relaxed break-all">
              {sessionStatus.log}
            </p>
          </Card>
        )}

        {/* ── 2. Failure Summary ─────────────────────────────── */}
        <SectionHeader title="Failure Summary" />
        <Card padding="none">
          {failureEntries.length === 0 ? (
            <DetailRow label="Status" value="No failures recorded" last />
          ) : (
            failureEntries.map(([reason, count], i) => (
              <DetailRow
                key={reason}
                label={REASON_LABELS[reason] ?? reason}
                value={`${count}×`}
                last={i === failureEntries.length - 1}
              />
            ))
          )}
        </Card>

        {/* ── 3. Recent Failures ─────────────────────────────── */}
        {recentFailures.length > 0 && (
          <>
            <SectionHeader title="Recent Failures" />
            <Card padding="none">
              {recentFailures.map((f, i) => {
                const entryKey = f.id != null ? String(f.id) : f.occurred_at
                return (
                  <div key={entryKey}>
                    <button
                      onClick={() => setExpandedShot(expandedShot === entryKey ? null : entryKey)}
                      className="w-full flex items-center justify-between px-4 py-3 text-left active:bg-divider transition-colors"
                    >
                      <div className="flex-1 mr-3">
                        <p className="text-[14px] font-medium text-text-primary">
                          {REASON_LABELS[f.reason] ?? f.reason}
                        </p>
                        <p className="text-[12px] text-text-secondary mt-0.5">
                          {PHASE_LABELS[f.phase] ?? f.phase} · {fmtStr(f.occurred_at)}
                        </p>
                        {f.message && (
                          <p className="text-[11px] text-text-muted mt-0.5 break-words">
                            {f.message.length > 80 ? f.message.slice(0, 80) + '…' : f.message}
                          </p>
                        )}
                      </div>
                      <ChevronIcon rotated={expandedShot === entryKey} />
                    </button>

                    {expandedShot === entryKey && f.screenshot && (
                      <div className="px-4 pb-4">
                        <img
                          src={`/screenshots/${f.screenshot}`}
                          alt={f.reason}
                          className="w-full rounded-xl border border-divider"
                          loading="lazy"
                        />
                      </div>
                    )}
                    {expandedShot === entryKey && !f.screenshot && (
                      <div className="px-4 pb-4">
                        <p className="text-[12px] text-text-muted italic">No screenshot captured</p>
                      </div>
                    )}

                    {i < recentFailures.length - 1 && <div className="h-px bg-divider mx-4" />}
                  </div>
                )
              })}
            </Card>
          </>
        )}

        {/* ── 4. Actions ─────────────────────────────────────── */}
        <SectionHeader title="Actions" />
        <Card padding="none">
          <ActionRow
            label={selectedJob ? `Book Now — ${selectedJob.class_title}` : 'Book Now'}
            detail={
              selectedJob
                ? `Job #${selectedJob.id} · force-attempt booking immediately`
                : 'Select a class in Plan first'
            }
            onClick={handleForce}
            loading={forceLoading}
            disabled={!selectedJob}
          />
          <div className="h-px bg-divider mx-4" />
          <ActionRow
            label="Check Now"
            detail="Run one booking check across all active classes"
            onClick={handleRunOnce}
            loading={runOnceLoading}
          />
        </Card>

        {(forceMsg || runOnceMsg) && (
          <Card padding="sm">
            {forceMsg   && <p className="text-[13px] text-text-secondary">{forceMsg}</p>}
            {runOnceMsg && <p className={`text-[13px] text-text-secondary ${forceMsg ? 'mt-2' : ''}`}>{runOnceMsg}</p>}
          </Card>
        )}

      </ScreenContainer>
    </>
  )
}

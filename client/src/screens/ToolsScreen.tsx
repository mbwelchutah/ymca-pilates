import { useEffect, useState } from 'react'
import { AppHeader } from '../components/layout/AppHeader'
import { ScreenContainer } from '../components/layout/ScreenContainer'
import { SectionHeader } from '../components/layout/SectionHeader'
import { Card } from '../components/ui/Card'
import { DetailRow } from '../components/ui/DetailRow'
import type { AppState } from '../types'
import type { SniperRunState } from '../lib/api'
import { api } from '../lib/api'
import { FAILURE_LABEL, failureToReadinessImpact } from '../lib/failureMapper'
import type { FailureType } from '../lib/failureTypes'
import { SESSION_LABEL, DISCOVERY_LABEL, ACTION_LABEL } from '../lib/readinessResolver'

interface FailureEntry {
  id:           number | null
  job_id:       number | null
  occurred_at:  string
  phase:        string
  reason:       string
  message:      string | null
  class_title:  string | null
  screenshot:   string | null
  category:     string | null
  label:        string | null
  expected:     string | null
  actual:       string | null
  url:          string | null
  context_json: string | null
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
  'login':          'Login',
  'schedule_scan':  'Schedule scan',
  'card_click':     'Card click',
  'modal_verify':   'Modal verify',
  'booking':        'Booking',
  'unknown':        'Unknown',
  // Taxonomy ExecutionPhase values
  'AUTH':         'Auth',
  'NAVIGATION':   'Navigation',
  'DISCOVERY':    'Discovery',
  'VERIFY':       'Verify',
  'MODAL':        'Modal',
  'ACTION':       'Action',
  'CONFIRMATION': 'Confirmation',
  'RECOVERY':     'Recovery',
  'SYSTEM':       'System',
}

// Impact badge color based on readiness value
function impactBadgeColor(value: string): string {
  if (value.includes('READY'))    return 'text-accent-green bg-accent-green/10'
  if (
    value.includes('REQUIRED') || value.includes('EXPIRED') ||
    value.includes('FAILED')   || value.includes('BLOCKED')
  ) return 'text-accent-red bg-accent-red/10'
  return 'text-text-muted bg-divider'
}

// Known evidence key → human label
const EVIDENCE_KEY_LABEL: Record<string, string> = {
  verifyTime:  'Time',
  verifyInst:  'Instructor',
  buttons:     'Buttons',
  buttonText:  'Button',
  title:       'Title',
  count:       'Count',
  url:         'URL',
}

function formatEvidenceValue(v: unknown): string {
  if (v === true)  return '✓'
  if (v === false) return '✗'
  if (Array.isArray(v)) return v.join(', ')
  return String(v)
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

const fmtTime = (s: string) =>
  new Date(s).toLocaleString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })

function trimUrl(raw: string): string {
  try {
    const u = new URL(raw)
    const p = u.pathname.length > 40 ? u.pathname.slice(0, 40) + '…' : u.pathname
    return u.hostname + p
  } catch {
    return raw.length > 50 ? raw.slice(0, 50) + '…' : raw
  }
}

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

function CameraIcon() {
  return (
    <svg width="11" height="10" viewBox="0 0 11 10" fill="none" className="inline-block ml-1.5 text-text-muted flex-shrink-0">
      <path
        d="M3.5 1L2.5 2.5H1C0.448 2.5 0 2.948 0 3.5V8.5C0 9.052 0.448 9.5 1 9.5H10C10.552 9.5 11 9.052 11 8.5V3.5C11 2.948 10.552 2.5 10 2.5H8.5L7.5 1H3.5ZM5.5 8C4.119 8 3 6.881 3 5.5C3 4.119 4.119 3 5.5 3C6.881 3 8 4.119 8 5.5C8 6.881 6.881 8 5.5 8Z"
        fill="currentColor"
      />
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

// ── Event dot for phase events ─────────────────────────────────────────────────

function EventDot({ hasFailure }: { hasFailure: boolean }) {
  return (
    <div className={`w-2 h-2 rounded-full flex-shrink-0 mt-1 ${hasFailure ? 'bg-accent-red' : 'bg-accent-green'}`} />
  )
}

// ── Last-run events section ────────────────────────────────────────────────────

function LastRunEvents({ sniperRunState }: { sniperRunState: SniperRunState | null }) {
  if (!sniperRunState || sniperRunState.events.length === 0) {
    return (
      <Card padding="none">
        <div className="px-4 py-3">
          <p className="text-[13px] text-text-muted">No run events recorded yet</p>
        </div>
      </Card>
    )
  }

  const { runId, events, sniperState, bundle, jobId } = sniperRunState
  const runLabel = runId ? fmtStr(runId) : '—'

  // Sniper state badge color
  const stateBadgeColor = (() => {
    if (sniperState === 'SNIPER_READY' || sniperState === 'SNIPER_BOOKING' || sniperState === 'SNIPER_CONFIRMING') return 'text-accent-green bg-accent-green/10'
    if (sniperState?.startsWith('SNIPER_BLOCKED')) return 'text-accent-red bg-accent-red/10'
    if (sniperState === 'SNIPER_ARMED') return 'text-accent-blue bg-accent-blue/10'
    return 'text-text-secondary bg-divider'
  })()

  return (
    <Card padding="none">
      {/* Header row: run timestamp + sniper state badge */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-divider">
        <div>
          <span className="text-[13px] text-text-muted">{runLabel}</span>
          {jobId != null && (
            <span className="text-[11px] text-text-muted ml-2">Job #{jobId}</span>
          )}
        </div>
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-pill ${stateBadgeColor}`}>
          {sniperState?.replace('SNIPER_', '').replace(/_/g, ' ')}
        </span>
      </div>

      {/* Readiness bundle summary */}
      <div className="flex gap-2 px-4 py-2 border-b border-divider flex-wrap">
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${impactBadgeColor(bundle.session)}`}>
          Session: {SESSION_LABEL[bundle.session]}
        </span>
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${impactBadgeColor(bundle.discovery)}`}>
          Class: {DISCOVERY_LABEL[bundle.discovery]}
        </span>
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${impactBadgeColor(bundle.action)}`}>
          Action: {ACTION_LABEL[bundle.action]}
        </span>
      </div>

      {/* Event rows */}
      {events.map((ev, i) => {
        const isLast = i === events.length - 1
        const phaseLabel  = PHASE_LABELS[ev.phase] ?? ev.phase
        const isKnownType = ev.failureType != null && (ev.failureType as string) in FAILURE_LABEL
        const failLabel   = ev.failureType
          ? (isKnownType ? FAILURE_LABEL[ev.failureType as FailureType] : ev.failureType.replace(/_/g, ' '))
          : null
        const impact      = isKnownType
          ? failureToReadinessImpact(ev.failureType as FailureType)
          : null
        const hasImpact   = impact && Object.keys(impact).length > 0
        const evidence    = ev.evidence ? Object.entries(ev.evidence) : []

        return (
          <div key={i} className={`flex gap-3 px-4 py-3 ${!isLast ? 'border-b border-divider' : ''}`}>
            <EventDot hasFailure={!!ev.failureType} />
            <div className="flex-1 min-w-0">

              {/* Phase chip + failure label + timestamp */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] font-semibold text-text-muted bg-divider rounded px-1.5 py-0.5 leading-tight flex-shrink-0">
                  {phaseLabel}
                </span>
                {failLabel && (
                  <span className={`text-[11px] font-medium truncate ${ev.failureType && isKnownType ? 'text-accent-red' : 'text-text-secondary'}`}>
                    {failLabel}
                  </span>
                )}
                <span className="text-[11px] text-text-muted ml-auto flex-shrink-0">{fmtTime(ev.timestamp)}</span>
              </div>

              {/* Message */}
              {ev.message && (
                <p className="text-[11px] text-text-muted mt-1 break-words leading-snug">{ev.message}</p>
              )}

              {/* Readiness impact pills */}
              {hasImpact && (
                <div className="flex gap-1.5 flex-wrap mt-1.5">
                  {impact!.session && (
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${impactBadgeColor(impact!.session)}`}>
                      Session: {SESSION_LABEL[impact!.session]}
                    </span>
                  )}
                  {impact!.discovery && (
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${impactBadgeColor(impact!.discovery)}`}>
                      Class: {DISCOVERY_LABEL[impact!.discovery]}
                    </span>
                  )}
                  {impact!.action && (
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${impactBadgeColor(impact!.action)}`}>
                      Action: {ACTION_LABEL[impact!.action]}
                    </span>
                  )}
                </div>
              )}

              {/* Evidence key-value pairs */}
              {evidence.length > 0 && (
                <div className="flex gap-x-3 gap-y-0.5 flex-wrap mt-1.5">
                  {evidence.map(([k, v]) => (
                    <span key={k} className="text-[10px] text-text-muted">
                      <span className="font-semibold">{EVIDENCE_KEY_LABEL[k] ?? k}:</span>{' '}
                      <span className={typeof v === 'boolean' ? (v ? 'text-accent-green' : 'text-accent-red') : ''}>
                        {formatEvidenceValue(v)}
                      </span>
                    </span>
                  ))}
                </div>
              )}

              {/* Screenshot thumbnail */}
              {ev.screenshot && (
                <img
                  src={`/screenshots/${ev.screenshot}`}
                  alt={ev.phase}
                  className="w-full mt-2 rounded-lg border border-divider"
                  loading="lazy"
                />
              )}

            </div>
          </div>
        )
      })}
    </Card>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function ToolsScreen({ appState, selectedJobId, refresh }: ToolsScreenProps) {
  const selectedJob = appState.jobs.find(j => j.id === selectedJobId) ?? appState.jobs[0] ?? null

  const [failures, setFailures]           = useState<FailureData | null>(null)
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(null)
  const [sniperRunState, setSniperRunState] = useState<SniperRunState | null>(null)
  const [expandedKey, setExpandedKey]     = useState<string | null>(null)
  const [forceLoading, setForceLoading]       = useState(false)
  const [forceMsg, setForceMsg]               = useState<{ ok: boolean; text: string } | null>(null)
  const [runOnceLoading, setRunOnceLoading]   = useState(false)
  const [runOnceMsg, setRunOnceMsg]           = useState<{ ok: boolean; text: string } | null>(null)
  const [preflightLoading, setPreflightLoading] = useState(false)
  const [preflightMsg, setPreflightMsg]       = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    api.getFailures().then(setFailures).catch(() => {})
    api.getStatus().then(setSessionStatus).catch(() => {})
    api.getSniperState().then(setSniperRunState).catch(() => {})
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
      setForceMsg({ ok: r.success !== false, text: r.message })
      refresh()
    } catch (e) {
      setForceMsg({ ok: false, text: e instanceof Error ? e.message : 'Unknown error' })
    } finally {
      setForceLoading(false)
    }
  }

  const handleRunOnce = async () => {
    setRunOnceLoading(true)
    setRunOnceMsg(null)
    try {
      const r = await api.runSchedulerOnce()
      setRunOnceMsg({ ok: r.success !== false, text: r.message })
      refresh()
    } catch (e) {
      setRunOnceMsg({ ok: false, text: e instanceof Error ? e.message : 'Unknown error' })
    } finally {
      setRunOnceLoading(false)
    }
  }

  const handlePreflight = async () => {
    if (!selectedJob) return
    setPreflightLoading(true)
    setPreflightMsg(null)
    try {
      const r = await api.runPreflight(selectedJob.id)
      if (r.sniperState) setSniperRunState(r.sniperState)
      setPreflightMsg({
        ok:   r.success,
        text: r.message ?? (r.success ? 'Preflight passed' : 'Preflight blocked'),
      })
    } catch (e) {
      setPreflightMsg({ ok: false, text: e instanceof Error ? e.message : 'Unknown error' })
    } finally {
      setPreflightLoading(false)
    }
  }

  const failureEntries = Object.entries(failures?.summary ?? {})
    .sort((a, b) => b[1] - a[1])
  const phaseEntries = Object.entries(failures?.by_phase ?? {})
    .sort((a, b) => b[1] - a[1])
  const recentFailures = failures?.recent ?? []

  return (
    <>
      <AppHeader subtitle="Diagnostics" />
      <ScreenContainer>

        {/* ── 1. Last Run ────────────────────────────────────── */}
        <SectionHeader title="Last Run" />
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

        {/* ── 1b. Last Run Events ─────────────────────────────── */}
        <SectionHeader
          title={`Run Events${sniperRunState?.events?.length ? ` · ${sniperRunState.events.length}` : ''}`}
        />
        <LastRunEvents sniperRunState={sniperRunState} />

        {/* ── 2a. Failure Summary — By Reason ────────────────── */}
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

        {/* ── 2b. Failure Summary — By Phase ─────────────────── */}
        {phaseEntries.length > 0 && (
          <>
            <SectionHeader title="By Phase" />
            <Card padding="none">
              {phaseEntries.map(([phase, count], i) => (
                <DetailRow
                  key={phase}
                  label={PHASE_LABELS[phase] ?? phase}
                  value={`${count}×`}
                  last={i === phaseEntries.length - 1}
                />
              ))}
            </Card>
          </>
        )}

        {/* ── 3. Recent Failures ─────────────────────────────── */}
        {recentFailures.length > 0 && (
          <>
            <SectionHeader title="Recent Failures" />
            <Card padding="none">
              {recentFailures.map((f, i) => {
                const entryKey = f.id != null ? String(f.id) : f.occurred_at
                const isOpen   = expandedKey === entryKey
                const primary  = f.label ?? REASON_LABELS[f.reason] ?? f.reason
                const msgSnip  = f.message
                  ? (f.message.length > 60 ? f.message.slice(0, 60) + '…' : f.message)
                  : null

                return (
                  <div key={entryKey}>
                    {/* ── Collapsed row ────────────────────── */}
                    <button
                      onClick={() => setExpandedKey(isOpen ? null : entryKey)}
                      className="w-full flex items-center justify-between px-4 py-3 text-left active:bg-divider transition-colors"
                    >
                      <div className="flex-1 mr-3 min-w-0">
                        <p className="text-[14px] font-medium text-text-primary flex items-center">
                          <span className="truncate">{primary}</span>
                          {f.screenshot && <CameraIcon />}
                        </p>
                        <p className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <span className="text-[11px] font-medium text-text-secondary bg-divider rounded px-1.5 py-0.5 leading-tight">
                            {PHASE_LABELS[f.phase] ?? f.phase}
                          </span>
                          <span className="text-[12px] text-text-muted">{fmtStr(f.occurred_at)}</span>
                        </p>
                        {msgSnip && (
                          <p className="text-[11px] text-text-muted mt-0.5 break-words">
                            {msgSnip}
                          </p>
                        )}
                      </div>
                      <ChevronIcon rotated={isOpen} />
                    </button>

                    {/* ── Expanded detail ──────────────────── */}
                    {isOpen && (
                      <div className="px-4 pb-4 space-y-3">

                        {f.message && (
                          <div className="bg-surface rounded-lg p-3 border border-divider">
                            <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wide mb-1">Message</p>
                            <p className="text-[12px] text-text-secondary leading-relaxed break-words font-mono">
                              {f.message}
                            </p>
                          </div>
                        )}

                        {f.expected != null && f.actual != null && (
                          <div className="bg-surface rounded-lg p-3 border border-divider space-y-1.5">
                            <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wide mb-1">Mismatch</p>
                            <div className="flex gap-2">
                              <span className="text-[10px] font-semibold text-text-muted w-16 flex-shrink-0 pt-px">Expected</span>
                              <span className="text-[12px] text-text-secondary font-mono break-all">{f.expected}</span>
                            </div>
                            <div className="flex gap-2">
                              <span className="text-[10px] font-semibold text-text-muted w-16 flex-shrink-0 pt-px">Actual</span>
                              <span className="text-[12px] text-text-secondary font-mono break-all">{f.actual}</span>
                            </div>
                          </div>
                        )}

                        {f.url && (
                          <div className="flex gap-2 items-start">
                            <span className="text-[10px] font-semibold text-text-muted w-8 flex-shrink-0 pt-px">URL</span>
                            <span className="text-[11px] text-text-muted font-mono break-all">{trimUrl(f.url)}</span>
                          </div>
                        )}

                        {f.screenshot ? (
                          <img
                            src={`/screenshots/${f.screenshot}`}
                            alt={f.reason}
                            className="w-full rounded-xl border border-divider"
                            loading="lazy"
                          />
                        ) : (
                          <p className="text-[12px] text-text-muted italic">No screenshot captured</p>
                        )}
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
            label={selectedJob ? `Preflight Check — ${selectedJob.class_title}` : 'Preflight Check'}
            detail={
              selectedJob
                ? `Job #${selectedJob.id} · verify readiness without booking`
                : 'Select a class in Plan first'
            }
            onClick={handlePreflight}
            loading={preflightLoading}
            disabled={!selectedJob}
          />
          <div className="h-px bg-divider mx-4" />
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

        {(preflightMsg || forceMsg || runOnceMsg) && (
          <Card padding="sm">
            {preflightMsg && (
              <p className={`text-[13px] ${preflightMsg.ok ? 'text-accent-green' : 'text-accent-red'}`}>
                {preflightMsg.text}
              </p>
            )}
            {forceMsg && (
              <p className={`text-[13px] ${forceMsg.ok ? 'text-accent-green' : 'text-accent-red'} ${preflightMsg ? 'mt-2' : ''}`}>
                {forceMsg.text}
              </p>
            )}
            {runOnceMsg && (
              <p className={`text-[13px] ${runOnceMsg.ok ? 'text-accent-green' : 'text-accent-red'} ${preflightMsg || forceMsg ? 'mt-2' : ''}`}>
                {runOnceMsg.text}
              </p>
            )}
          </Card>
        )}

      </ScreenContainer>
    </>
  )
}

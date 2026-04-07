import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AppHeader } from '../components/layout/AppHeader'
import { ScreenContainer } from '../components/layout/ScreenContainer'
import { SectionHeader } from '../components/layout/SectionHeader'
import { Card } from '../components/ui/Card'
import { DetailRow } from '../components/ui/DetailRow'
import type { AppState, SessionStatus } from '../types'
import type { SniperRunState, SniperTiming } from '../lib/api'
import { api } from '../lib/api'
import { FAILURE_LABEL, failureToReadinessImpact } from '../lib/failureMapper'
import type { FailureType } from '../lib/failureTypes'
import { SESSION_LABEL, DISCOVERY_LABEL, ACTION_LABEL } from '../lib/readinessResolver'
import { generateSuggestions } from '../lib/suggestions'

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

interface TrendWindow {
  byReason: Array<{ reason: string; count: number }>
  byPhase:  Array<{ phase:  string; count: number }>
  total:    number
}

interface FailureData {
  recent:   FailureEntry[]
  summary:  Record<string, number>
  by_phase: Record<string, number>
  trends:   { h24: TrendWindow; d7: TrendWindow }
}

interface BotStatus {
  active: boolean
  log: string
  success: boolean | null
}

interface ToolsScreenProps {
  appState: AppState
  selectedJobId: number | null
  refresh: () => void
  onAccount?: () => void
  accountAttention?: boolean
  scrollTo?: string
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
  verifyTime:       'Time',
  verifyInst:       'Instructor',
  buttons:          'Buttons',
  buttonText:       'Button',
  title:            'Title',
  count:            'Count',
  url:              'URL',
  // Discovery phase
  matched:          'Matched class',
  score:            'Match score',
  signals:          'Signals',
  second:           'Runner-up',
  nearMisses:       'Near misses',
  // Action phase
  actionState:      'Action state',
  buttonsVisible:   'Buttons',
  registerStrategy: 'Register via',
  waitlistStrategy: 'Waitlist via',
  // Auth phase
  provider:         'Provider',
  // Modal phase
  modalPreview:     'Preview',
}

// Evidence keys that are too long for the compact inline display —
// screenshot is rendered as an <img> below the evidence row anyway.
const EVIDENCE_KEY_SKIP = new Set(['screenshot', 'modalPreview', 'nearMisses', 'second'])

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

// ── Timing helpers ─────────────────────────────────────────────────────────────

function fmtDelay(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 0)     return `${Math.round(-ms / 100) / 10}s early`
  if (ms < 1000)  return `${ms}ms`
  return `${Math.round(ms / 100) / 10}s`
}

function TimingRow({ timing }: { timing: SniperTiming }) {
  const hasData = timing.openToCardMs != null || timing.openToClickMs != null
  if (!hasData && timing.pollAttemptsPostOpen === 0) return null
  return (
    <div className="px-4 py-2 border-b border-divider bg-bg-secondary/40">
      <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wide mb-1.5">Sniper Timing</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {timing.openToCardMs != null && (
          <span className="text-[11px] text-text-secondary">
            Open → Card: <span className="font-semibold text-text-primary">{fmtDelay(timing.openToCardMs)}</span>
          </span>
        )}
        {timing.openToClickMs != null && (
          <span className="text-[11px] text-text-secondary">
            Open → Click: <span className="font-semibold text-text-primary">{fmtDelay(timing.openToClickMs)}</span>
          </span>
        )}
        {timing.pollAttemptsPostOpen > 0 && (
          <span className="text-[11px] text-text-secondary">
            Polls after open: <span className="font-semibold text-text-primary">{timing.pollAttemptsPostOpen}</span>
          </span>
        )}
      </div>
    </div>
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

      {/* Timing row — only shown when sniper poll data is available */}
      {sniperRunState.timing && <TimingRow timing={sniperRunState.timing} />}

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

              {/* Evidence key-value pairs — skip keys that are too long for inline display */}
              {evidence.filter(([k]) => !EVIDENCE_KEY_SKIP.has(k)).length > 0 && (
                <div className="flex gap-x-3 gap-y-0.5 flex-wrap mt-1.5">
                  {evidence.filter(([k]) => !EVIDENCE_KEY_SKIP.has(k)).map(([k, v]) => (
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

// ── Last Check Now diagnostics ─────────────────────────────────────────────────
// Shows the persisted per-stage detail from the last user-triggered Check Now
// (stored in lastPreflightSnapshot since Stage 9).  Each phase is a collapsible
// row inside a single card.  This section lives only in Tools — Now shows only
// the summary label; the evidence traces belong here.

function KVRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2.5 items-start">
      <span className="text-[10px] font-semibold text-text-muted w-[76px] flex-shrink-0 pt-px leading-relaxed uppercase tracking-wide">
        {label}
      </span>
      <span className={`text-[11px] text-text-secondary break-words leading-relaxed flex-1 min-w-0 ${mono ? 'font-mono' : ''}`}>
        {value}
      </span>
    </div>
  )
}

function CheckNowVerdictBadge({ verdict }: { verdict: string }) {
  const color =
    verdict === 'ready' || verdict === 'found' || verdict === 'reachable'
      ? 'text-accent-green bg-accent-green/10'
      : verdict === 'waitlist_only' || verdict === 'login_required'
      ? 'text-accent-amber bg-accent-amber/10'
      : 'text-accent-red bg-accent-red/10'
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0 ${color}`}>
      {verdict.replace(/_/g, ' ')}
    </span>
  )
}

function CheckNowPhaseRow({
  id, phase, verdict, summary, expanded, onToggle, children,
}: {
  id: string
  phase: string
  verdict: string
  summary: string
  expanded: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="border-b border-divider last:border-0">
      <button
        onClick={onToggle}
        className="flex items-center gap-2 w-full px-4 py-3 text-left active:bg-divider/50 transition-colors"
      >
        <span className="text-[10px] font-semibold text-text-muted bg-divider rounded px-1.5 py-0.5 w-[66px] flex-shrink-0 text-center leading-tight">
          {phase}
        </span>
        <CheckNowVerdictBadge verdict={verdict} />
        <span className="text-[12px] text-text-secondary flex-1 mx-1 truncate">{summary}</span>
        <ChevronIcon rotated={expanded} />
      </button>
      {expanded && (
        <div className="px-4 pb-3 space-y-2 border-t border-divider bg-bg-secondary/30">
          <div className="pt-2 space-y-1.5">{children}</div>
        </div>
      )}
    </div>
  )
}

function LastCheckNowSection({ sniperRunState }: { sniperRunState: SniperRunState | null }) {
  const [expandedPhase, setExpandedPhase] = useState<string | null>(null)

  const snap = sniperRunState?.lastPreflightSnapshot
  if (!snap) return null
  const { authDetail, discoveryDetail, modalDetail, actionDetail } = snap
  if (!authDetail && !discoveryDetail && !modalDetail && !actionDetail) return null

  const toggle = (id: string) => setExpandedPhase(prev => prev === id ? null : id)

  return (
    <>
      <SectionHeader id="tools-last-check" title={`Last Check · ${fmtStr(snap.checkedAt)}`} />
      <Card padding="none">

        {/* Session / Auth */}
        {authDetail && (
          <CheckNowPhaseRow
            id="auth" phase="Session"
            verdict={authDetail.verdict}
            summary={
              authDetail.provider
                ? `${authDetail.provider} · ${(authDetail.detail ?? '').slice(0, 50)}`
                : (authDetail.detail ?? '').slice(0, 65)
            }
            expanded={expandedPhase === 'auth'}
            onToggle={() => toggle('auth')}
          >
            {authDetail.provider && <KVRow label="Provider" value={authDetail.provider} />}
            {authDetail.detail   && <KVRow label="Detail"   value={authDetail.detail} />}
          </CheckNowPhaseRow>
        )}

        {/* Discovery */}
        {discoveryDetail && (
          <CheckNowPhaseRow
            id="discovery" phase="Discovery"
            verdict={discoveryDetail.found ? 'found' : 'not found'}
            summary={
              discoveryDetail.matched
                ? `${discoveryDetail.matched.slice(0, 55)}${discoveryDetail.score ? ` · ${discoveryDetail.score}pts` : ''}`
                : discoveryDetail.found ? 'Class found' : 'Class not on schedule'
            }
            expanded={expandedPhase === 'discovery'}
            onToggle={() => toggle('discovery')}
          >
            {discoveryDetail.matched    && <KVRow label="Matched"    value={discoveryDetail.matched} />}
            {discoveryDetail.score      && <KVRow label="Score"      value={`${discoveryDetail.score} pts`} />}
            {discoveryDetail.signals    && <KVRow label="Signals"    value={discoveryDetail.signals} />}
            {discoveryDetail.second     && <KVRow label="Runner-up"  value={discoveryDetail.second} />}
            {discoveryDetail.nearMisses && <KVRow label="Near misses" value={discoveryDetail.nearMisses} />}
          </CheckNowPhaseRow>
        )}

        {/* Modal */}
        {modalDetail && (
          <CheckNowPhaseRow
            id="modal" phase="Modal"
            verdict={modalDetail.verdict}
            summary={
              modalDetail.buttonsVisible?.length
                ? modalDetail.buttonsVisible.join(', ')
                : (modalDetail.detail ?? '').slice(0, 65)
            }
            expanded={expandedPhase === 'modal'}
            onToggle={() => toggle('modal')}
          >
            {modalDetail.detail          && <KVRow label="Result"   value={modalDetail.detail} />}
            {modalDetail.buttonsVisible?.length && (
              <KVRow label="Buttons" value={modalDetail.buttonsVisible.join(', ')} />
            )}
            {modalDetail.modalPreview    && (
              <KVRow label="Preview" value={modalDetail.modalPreview.slice(0, 120)} mono />
            )}
            {modalDetail.screenshot && (
              <img
                src={`/screenshots/${modalDetail.screenshot}`}
                alt="Modal screenshot"
                className="w-full mt-1 rounded-lg border border-divider"
                loading="lazy"
              />
            )}
          </CheckNowPhaseRow>
        )}

        {/* Action */}
        {actionDetail && (
          <CheckNowPhaseRow
            id="action" phase="Action"
            verdict={actionDetail.verdict}
            summary={
              actionDetail.actionState
                ? actionDetail.actionState.replace(/_/g, ' ').toLowerCase()
                : (actionDetail.detail ?? '').slice(0, 65)
            }
            expanded={expandedPhase === 'action'}
            onToggle={() => toggle('action')}
          >
            {actionDetail.detail          && <KVRow label="Result"       value={actionDetail.detail} />}
            {actionDetail.actionState     && <KVRow label="State"        value={actionDetail.actionState} mono />}
            {actionDetail.buttonsVisible?.length && (
              <KVRow label="Buttons" value={actionDetail.buttonsVisible.join(', ')} />
            )}
            {actionDetail.registerStrategy && (
              <KVRow label="Register via" value={actionDetail.registerStrategy} mono />
            )}
            {actionDetail.waitlistStrategy && (
              <KVRow label="Waitlist via" value={actionDetail.waitlistStrategy} mono />
            )}
          </CheckNowPhaseRow>
        )}

      </Card>
    </>
  )
}

// ── Stage 1: Compact Last Run summary card ─────────────────────────────────────

function resultToOutcome(result: string | null): {
  label: string; reason: string; color: string; dot: string
} {
  switch (result) {
    case 'booked':
      return { label: 'Booked',      reason: 'Booked successfully',             color: 'text-accent-green', dot: 'bg-accent-green' }
    case 'dry_run':
      return { label: 'Simulated',   reason: 'Simulated booking (test mode)',    color: 'text-accent-blue',  dot: 'bg-accent-blue'  }
    case 'found_not_open_yet':
      return { label: 'Waiting',     reason: 'Registration not open yet',        color: 'text-text-muted',   dot: 'bg-text-muted'   }
    case 'not_found':
      return { label: 'Not Found',   reason: 'Class not found on schedule',      color: 'text-accent-amber', dot: 'bg-accent-amber'  }
    case 'skipped':
      return { label: 'Skipped',     reason: 'Booking check was skipped',        color: 'text-text-muted',   dot: 'bg-text-muted'   }
    default:
      return { label: 'Failed',      reason: 'Booking attempt failed',           color: 'text-accent-red',   dot: 'bg-accent-red'   }
  }
}

interface JobLike {
  id: number
  class_title: string
  last_run_at: string | null
  last_result: string | null
  last_error_message: string | null
}

function LastRunSummaryCard({ lastRunJob, botStatus }: {
  lastRunJob: JobLike | null
  botStatus:  BotStatus | null
}) {
  const [expanded, setExpanded] = useState(false)

  if (!lastRunJob?.last_run_at) {
    return (
      <Card padding="none">
        <div className="px-4 py-3.5 flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-text-muted/30 flex-shrink-0" />
          <div>
            <p className="text-[15px] font-medium text-text-secondary">No runs yet</p>
            <p className="text-[12px] text-text-muted mt-0.5">Scheduler {botStatus?.active ? 'running' : 'idle'}</p>
          </div>
        </div>
      </Card>
    )
  }

  const { label, reason: baseReason, color, dot } = resultToOutcome(lastRunJob.last_result)
  const errorShort = lastRunJob.last_error_message
    ? (lastRunJob.last_error_message.length > 55
        ? lastRunJob.last_error_message.slice(0, 55) + '…'
        : lastRunJob.last_error_message)
    : null
  const reason = errorShort ?? baseReason

  return (
    <Card padding="none">
      {/* ── Collapsed row ───────────────────────────────────── */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full px-4 py-3.5 flex items-center justify-between gap-3 text-left active:bg-divider/40 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${dot}`} />
            <span className={`text-[16px] font-semibold leading-tight ${color}`}>{label}</span>
            <span className="text-[12px] text-text-muted">{fmtStr(lastRunJob.last_run_at)}</span>
          </div>
          <p className="text-[13px] text-text-secondary mt-1 truncate">{reason}</p>
        </div>
        <ChevronIcon rotated={expanded} />
      </button>

      {/* ── Expanded detail ─────────────────────────────────── */}
      {expanded && (
        <div className="border-t border-divider">
          <DetailRow label="Class"      value={lastRunJob.class_title ?? '—'} />
          <DetailRow label="Job"        value={`#${lastRunJob.id}`} />
          <DetailRow label="Scheduler"  value={botStatus?.active ? 'Running' : 'Idle'} />
          <DetailRow
            label="Result"
            value={lastRunJob.last_result ? (RESULT_LABELS[lastRunJob.last_result] ?? lastRunJob.last_result) : '—'}
            last={!lastRunJob.last_error_message}
          />
          {lastRunJob.last_error_message && (
            <DetailRow label="Error" value={lastRunJob.last_error_message} last />
          )}
        </div>
      )}
    </Card>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function ToolsScreen({ appState, selectedJobId, refresh, onAccount, accountAttention, scrollTo }: ToolsScreenProps) {
  const selectedJob = appState.jobs.find(j => j.id === selectedJobId) ?? appState.jobs[0] ?? null
  const scrolledRef = useRef<string | undefined>(undefined)

  const [failures, setFailures]           = useState<FailureData | null>(null)
  const [trendWindow, setTrendWindow]     = useState<'h24' | 'd7'>('h24')
  const [botStatus, setBotStatus]         = useState<BotStatus | null>(null)
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(null)
  const [sniperRunState, setSniperRunState] = useState<SniperRunState | null>(null)
  const [expandedKey, setExpandedKey]     = useState<string | null>(null)
  const [forceLoading, setForceLoading]       = useState(false)
  const [forceMsg, setForceMsg]               = useState<{ ok: boolean; text: string } | null>(null)
  const [runOnceLoading, setRunOnceLoading]   = useState(false)
  const [runOnceMsg, setRunOnceMsg]           = useState<{ ok: boolean; text: string } | null>(null)
  const [preflightLoading, setPreflightLoading] = useState(false)
  const [preflightMsg, setPreflightMsg]       = useState<{ ok: boolean; text: string } | null>(null)

  // ── Auto-preflight config (Stage 9.2) ─────────────────────────────────────
  const [autoPreflightConfig, setAutoPreflightConfig] = useState<{
    enabled:     boolean
    lastRun:     { timestamp: string; triggerName: string; status: string; classTitle: string; message: string } | null
    nextTrigger: { triggerName: string; msUntil: number } | null
  } | null>(null)
  const [apfToggling, setApfToggling] = useState(false)

  // ── Session keepalive config (Stage 9.3) ──────────────────────────────────
  const [keepaliveConfig, setKeepaliveConfig] = useState<{
    enabled:         boolean
    intervalMinutes: number
    intervalHours:   number
    lastRun:         { timestamp: string; valid: boolean; detail: string; screenshot: string | null } | null
    next:            { msUntil: number; intervalMinutes: number; intervalHours: number } | null
  } | null>(null)
  const [kaToggling, setKaToggling] = useState(false)

  useEffect(() => {
    api.getFailures().then(setFailures).catch(() => {})
    api.getStatus().then(setBotStatus).catch(() => {})
    api.getSessionStatus().then(setSessionStatus).catch(() => {})
    api.getSniperState().then(setSniperRunState).catch(() => {})
    api.getAutoPreflightConfig().then(setAutoPreflightConfig).catch(() => {})
    api.getSessionKeepaliveConfig().then(setKeepaliveConfig).catch(() => {})
  }, [])

  // ── Auto-scroll to linked section when arriving from Now ─────────────────
  useEffect(() => {
    if (!scrollTo || scrollTo === scrolledRef.current) return
    scrolledRef.current = scrollTo
    const el = document.getElementById(scrollTo)
    if (el) {
      setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120)
    }
  }, [scrollTo])

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

  const handleAutoPreflightToggle = async () => {
    if (apfToggling || !autoPreflightConfig) return
    setApfToggling(true)
    try {
      const next = !autoPreflightConfig.enabled
      const r = await api.setAutoPreflightEnabled(next)
      if (r.success) setAutoPreflightConfig(prev => prev ? { ...prev, enabled: r.enabled } : null)
    } catch { /* ignored */ } finally { setApfToggling(false) }
  }

  const handleKeepaliveToggle = async () => {
    if (kaToggling || !keepaliveConfig) return
    setKaToggling(true)
    try {
      const next = !keepaliveConfig.enabled
      const r = await api.setSessionKeepaliveConfig(next, keepaliveConfig.intervalMinutes)
      if (r.success) setKeepaliveConfig(prev => prev ? { ...prev, enabled: r.enabled } : null)
    } catch { /* ignored */ } finally { setKaToggling(false) }
  }

  const recentFailures = failures?.recent ?? []

  const suggestions = generateSuggestions({
    trends7d:    failures?.trends?.d7 ?? null,
    sessionValid: sessionStatus?.valid ?? null,
    sniperState:  sniperRunState?.sniperState ?? null,
  })

  // ── Readiness dot helpers ────────────────────────────────────────────────
  const daxkoToLabel = (s: SessionStatus['daxko'] | undefined): { label: string; dot: string } => {
    switch (s) {
      case 'DAXKO_READY':      return { label: 'Ready',       dot: 'bg-accent-green' }
      case 'AUTH_NEEDS_LOGIN': return { label: 'Needs login', dot: 'bg-accent-red'   }
      default:                 return { label: 'Unknown',     dot: 'bg-divider'      }
    }
  }
  const fwToLabel = (s: SessionStatus['familyworks'] | undefined): { label: string; dot: string } => {
    switch (s) {
      case 'FAMILYWORKS_READY':           return { label: 'Ready',   dot: 'bg-accent-green' }
      case 'FAMILYWORKS_SESSION_MISSING': return { label: 'Missing', dot: 'bg-accent-red'   }
      case 'FAMILYWORKS_SESSION_EXPIRED': return { label: 'Expired', dot: 'bg-accent-red'   }
      default:                            return { label: 'Unknown', dot: 'bg-divider'      }
    }
  }
  const bundleDot = (val: string): string => {
    if (val.includes('READY') || val.includes('FOUND') || val.includes('REACHABLE')) return 'bg-accent-green'
    if (val.includes('REQUIRED') || val.includes('EXPIRED') || val.includes('MISSING') ||
        val.includes('BLOCKED')  || val.includes('FAILED'))                            return 'bg-accent-red'
    if (val.includes('NOT_TESTED')) return 'bg-divider'
    return 'bg-accent-amber'
  }

  return (
    <>
      <AppHeader subtitle="Tools" onAccount={onAccount} accountAttention={accountAttention} />
      <ScreenContainer>

        {/* ── Last Run (compact, tap to expand) ───────────── */}
        <SectionHeader title="Last Run" id="tools-last-run" />
        <LastRunSummaryCard lastRunJob={lastRunJob} botStatus={botStatus} />

        {/* ── Actions ──────────────────────────────────────── */}
        <SectionHeader title="Actions" id="tools-actions" />
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

        {/* ── Readiness ────────────────────────────────────── */}
        <SectionHeader title="Readiness" id="tools-readiness" />
        <Card padding="none">
          {/* Session (Daxko auth) */}
          {(() => {
            const { label, dot } = daxkoToLabel(sessionStatus?.daxko)
            return (
              <div className="flex items-center justify-between px-4 py-3 border-b border-divider">
                <span className="text-[14px] text-text-secondary">Session</span>
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
                  <span className="text-[14px] font-medium text-text-primary">{label}</span>
                </div>
              </div>
            )
          })()}
          {/* Schedule (FamilyWorks) */}
          {(() => {
            const { label, dot } = fwToLabel(sessionStatus?.familyworks)
            return (
              <div className="flex items-center justify-between px-4 py-3 border-b border-divider">
                <span className="text-[14px] text-text-secondary">Schedule</span>
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
                  <span className="text-[14px] font-medium text-text-primary">{label}</span>
                </div>
              </div>
            )
          })()}
          {/* Discovery */}
          {sniperRunState?.bundle && sniperRunState.bundle.discovery !== 'DISCOVERY_NOT_TESTED' && (
            <div className="flex items-center justify-between px-4 py-3 border-b border-divider">
              <span className="text-[14px] text-text-secondary">Class</span>
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${bundleDot(sniperRunState.bundle.discovery)}`} />
                <span className="text-[14px] font-medium text-text-primary">
                  {DISCOVERY_LABEL[sniperRunState.bundle.discovery] ?? sniperRunState.bundle.discovery}
                </span>
              </div>
            </div>
          )}
          {/* Modal */}
          {sniperRunState?.bundle && sniperRunState.bundle.modal &&
           sniperRunState.bundle.modal !== 'MODAL_NOT_TESTED' && (
            <div className="flex items-center justify-between px-4 py-3 border-b border-divider">
              <span className="text-[14px] text-text-secondary">Modal</span>
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${bundleDot(sniperRunState.bundle.modal)}`} />
                <span className="text-[14px] font-medium text-text-primary">
                  {(sniperRunState.bundle.modal as string).replace(/_/g, ' ').replace('MODAL ', '')}
                </span>
              </div>
            </div>
          )}
          {/* Action */}
          {sniperRunState?.bundle && sniperRunState.bundle.action !== 'ACTION_NOT_TESTED' && (
            <div className="flex items-center justify-between px-4 py-3 border-b border-divider">
              <span className="text-[14px] text-text-secondary">Action</span>
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${bundleDot(sniperRunState.bundle.action)}`} />
                <span className="text-[14px] font-medium text-text-primary">
                  {ACTION_LABEL[sniperRunState.bundle.action] ?? sniperRunState.bundle.action}
                </span>
              </div>
            </div>
          )}
          {/* Last check timestamp */}
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-[14px] text-text-secondary">Last checked</span>
            <span className="text-[13px] text-text-muted">
              {sniperRunState?.runId ? fmtStr(sniperRunState.runId) : sessionStatus?.lastVerified ? fmtStr(sessionStatus.lastVerified) : '—'}
            </span>
          </div>
        </Card>

        {/* ── Run Events ───────────────────────────────────── */}
        <SectionHeader
          id="tools-run-events"
          title={`Run Events${sniperRunState?.events?.length ? ` · ${sniperRunState.events.length}` : ''}`}
        />
        <LastRunEvents sniperRunState={sniperRunState} />

        {/* ── 1d. Last Check Now (per-phase diagnostics) ──────── */}
        <LastCheckNowSection sniperRunState={sniperRunState} />

        {/* ── Automation Health ─────────────────────────────── */}
        <SectionHeader title="Automation Health" />
        <Card padding="none">

          {/* ── Auto Preflight row ──────────────────────────── */}
          {(() => {
            const cfg = autoPreflightConfig
            const apfMs   = cfg?.nextTrigger?.msUntil
            const apfNext = apfMs != null ? (() => {
              const d = Math.floor(apfMs / 86_400_000)
              const h = Math.floor((apfMs % 86_400_000) / 3_600_000)
              const m = Math.floor((apfMs % 3_600_000) / 60_000)
              return d > 0 ? `Next in ${d}d ${h}h` : h > 0 ? `Next in ${h}h ${m}m` : `Next in ${m}m`
            })() : cfg?.enabled ? 'None scheduled' : null

            let apfHealth = 'Off'
            let apfDot    = 'bg-text-muted/40'
            let apfColor  = 'text-text-muted'
            if (cfg?.enabled) {
              if (!cfg.lastRun)                         { apfHealth = 'Enabled'; apfDot = 'bg-accent-blue'; apfColor = 'text-text-secondary' }
              else if (cfg.lastRun.status === 'pass')   { apfHealth = 'Healthy';        apfDot = 'bg-accent-green'; apfColor = 'text-accent-green' }
              else if (cfg.lastRun.status === 'fail')   { apfHealth = 'Last run failed'; apfDot = 'bg-accent-red';   apfColor = 'text-accent-red'   }
              else                                      { apfHealth = 'Needs review';   apfDot = 'bg-accent-amber'; apfColor = 'text-accent-amber' }
            }

            return (
              <button
                onClick={handleAutoPreflightToggle}
                disabled={apfToggling || cfg === null}
                className="flex items-center justify-between w-full px-4 py-3.5 text-left active:opacity-60 transition-opacity border-b border-divider"
              >
                <div className="flex-1 mr-4 min-w-0">
                  <p className="text-[14px] font-medium text-text-primary leading-tight">
                    {apfToggling ? 'Updating…' : 'Auto Preflight'}
                  </p>
                  <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                    <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${apfDot}`} />
                    <span className={`text-[12px] font-medium ${apfColor}`}>{apfHealth}</span>
                    {apfNext && <span className="text-[12px] text-text-muted">· {apfNext}</span>}
                  </div>
                </div>
                <div className={`w-11 h-6 rounded-full flex items-center px-0.5 transition-colors flex-shrink-0 ${
                  cfg?.enabled ? 'bg-accent-blue' : 'bg-divider'
                }`}>
                  <div className={`w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${
                    cfg?.enabled ? 'translate-x-5' : 'translate-x-0'
                  }`} />
                </div>
              </button>
            )
          })()}

          {/* ── Session Check row ───────────────────────────── */}
          {(() => {
            const cfg = keepaliveConfig
            const kaMs   = cfg?.next?.msUntil
            const kaNext = kaMs != null ? (() => {
              const h = Math.floor(kaMs / 3_600_000)
              const m = Math.floor((kaMs % 3_600_000) / 60_000)
              return kaMs < 60_000 ? 'Due now' : h > 0 ? `Next in ${h}h ${m}m` : `Next in ${m}m`
            })() : cfg?.enabled ? 'None scheduled' : null

            let kaHealth = 'Off'
            let kaDot    = 'bg-text-muted/40'
            let kaColor  = 'text-text-muted'
            if (cfg?.enabled) {
              if (!cfg.lastRun)              { kaHealth = 'Enabled';      kaDot = 'bg-accent-blue';  kaColor = 'text-text-secondary' }
              else if (cfg.lastRun.valid)    { kaHealth = 'Healthy';      kaDot = 'bg-accent-green'; kaColor = 'text-accent-green'   }
              else                           { kaHealth = 'Needs review'; kaDot = 'bg-accent-red';   kaColor = 'text-accent-red'     }
            }

            return (
              <button
                onClick={handleKeepaliveToggle}
                disabled={kaToggling || cfg === null}
                className="flex items-center justify-between w-full px-4 py-3.5 text-left active:opacity-60 transition-opacity"
              >
                <div className="flex-1 mr-4 min-w-0">
                  <p className="text-[14px] font-medium text-text-primary leading-tight">
                    {kaToggling ? 'Updating…' : 'Session Check'}
                  </p>
                  <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                    <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${kaDot}`} />
                    <span className={`text-[12px] font-medium ${kaColor}`}>{kaHealth}</span>
                    {kaNext && <span className="text-[12px] text-text-muted">· {kaNext}</span>}
                  </div>
                </div>
                <div className={`w-11 h-6 rounded-full flex items-center px-0.5 transition-colors flex-shrink-0 ${
                  cfg?.enabled ? 'bg-accent-blue' : 'bg-divider'
                }`}>
                  <div className={`w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${
                    cfg?.enabled ? 'translate-x-5' : 'translate-x-0'
                  }`} />
                </div>
              </button>
            )
          })()}

        </Card>

        {/* ── 1e. Suggestions ─────────────────────────────────── */}
        {suggestions.length > 0 && (
          <>
            <SectionHeader title="Suggestions" />
            <div className="space-y-2">
              {suggestions.slice(0, 5).map(s => (
                <Card key={s.id} padding="sm" className="border border-accent-amber/30 bg-accent-amber/5 shadow-none">
                  <div className="flex items-start gap-2.5">
                    <span className="text-[15px] flex-shrink-0 mt-px">💡</span>
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-text-primary leading-snug">
                        {s.text}
                      </p>
                      {s.detail && (
                        <p className="text-[11px] text-text-secondary mt-0.5 leading-relaxed">
                          {s.detail}
                        </p>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </>
        )}

        {/* ── 2. Failure Trends ───────────────────────────────── */}
        {/* Segment control header row */}
        <div className="flex items-center justify-between px-1 pt-6 pb-1">
          <h2 className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide">
            Failure Trends
          </h2>
          <div className="flex bg-divider rounded-lg p-0.5 gap-0.5 flex-shrink-0">
            {(['h24', 'd7'] as const).map(w => (
              <button
                key={w}
                onClick={() => setTrendWindow(w)}
                className={`text-[12px] font-medium px-3 py-1 rounded-md transition-colors ${
                  trendWindow === w
                    ? 'bg-white text-text-primary shadow-sm'
                    : 'text-text-muted'
                }`}
              >
                {w === 'h24' ? '24h' : '7d'}
              </button>
            ))}
          </div>
        </div>

        {(() => {
          const window = failures?.trends?.[trendWindow]
          if (!window) return (
            <Card padding="none">
              <DetailRow label="Status" value="No data yet" last />
            </Card>
          )

          const { byReason, byPhase, total } = window
          const topReasons = byReason.slice(0, 5)
          const topPhases  = byPhase.slice(0, 3)

          if (total === 0) return (
            <Card padding="sm" className="border border-divider shadow-none bg-surface">
              <p className="text-[13px] text-text-muted text-center">
                No failures in the last {trendWindow === 'h24' ? '24 hours' : '7 days'}
              </p>
            </Card>
          )

          return (
            <>
              {/* Top failure reasons */}
              <Card padding="none">
                <div className="px-4 pt-3 pb-2 flex items-center justify-between border-b border-divider">
                  <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">
                    By Failure Type
                  </span>
                  <span className="text-[11px] text-text-muted">{total} total</span>
                </div>
                {topReasons.map((r, i) => {
                  const pct = total > 0 ? Math.round((r.count / total) * 100) : 0
                  return (
                    <div key={r.reason} className={`px-4 py-2.5 ${i < topReasons.length - 1 ? 'border-b border-divider' : ''}`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[13px] text-text-primary leading-tight flex-1 mr-2 truncate">
                          {REASON_LABELS[r.reason] ?? r.reason}
                        </span>
                        <span className="text-[12px] font-medium text-text-secondary flex-shrink-0">
                          {r.count}×
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-divider rounded-full overflow-hidden">
                          <div
                            className="h-full bg-accent-red/60 rounded-full"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-text-muted w-8 text-right flex-shrink-0">{pct}%</span>
                      </div>
                    </div>
                  )
                })}
              </Card>

              {/* Phase breakdown */}
              {topPhases.length > 0 && (
                <Card padding="none">
                  <div className="px-4 pt-3 pb-2 border-b border-divider">
                    <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">
                      By Phase
                    </span>
                  </div>
                  {topPhases.map((p, i) => (
                    <DetailRow
                      key={p.phase}
                      label={PHASE_LABELS[p.phase] ?? p.phase}
                      value={`${p.count}×`}
                      last={i === topPhases.length - 1}
                    />
                  ))}
                </Card>
              )}
            </>
          )
        })()}

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

      </ScreenContainer>
    </>
  )
}

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AppHeader } from '../components/layout/AppHeader'
import { ScreenContainer } from '../components/layout/ScreenContainer'
import { SectionHeader } from '../components/layout/SectionHeader'
import { Card } from '../components/ui/Card'
import { DetailRow } from '../components/ui/DetailRow'
import { ScreenshotLightbox } from '../components/ui/ScreenshotLightbox'
import type { AppState, SessionStatus, AuthStatusEnum } from '../types'
import type { SniperRunState, SniperTiming } from '../lib/api'
import { api } from '../lib/api'
import { FAILURE_LABEL, failureToReadinessImpact } from '../lib/failureMapper'
import type { FailureType } from '../lib/failureTypes'
import { SESSION_LABEL, DISCOVERY_LABEL, ACTION_LABEL, MODAL_LABEL } from '../lib/readinessResolver'
import type { ClassTruthResult } from '../lib/classTruth'
import { CLASS_STATE_LABEL } from '../lib/classTruth'

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

interface JobReliability {
  job_id:        number
  failure_count: number
  top_reason:    string | null
}

interface FailureData {
  recent:   FailureEntry[]
  summary:  Record<string, number>
  by_phase: Record<string, number>
  trends:   { h1: TrendWindow; h6: TrendWindow; h24: TrendWindow; d7: TrendWindow }
  byJob:    JobReliability[]
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
  authStatus?: AuthStatusEnum | null
  scrollTo?: string
  tab?: import('../components/nav/TabBar').Tab
  onTabChange?: (tab: import('../components/nav/TabBar').Tab) => void
  scrolled?: boolean
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
  'booking_not_open':            'Registration not open yet',
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
  'gate':        'Registration gate',
  'action':      'Registration action',
  'post_click':  'Post-click check',
  'recovery':    'Stale recovery',
  'login':          'Login',
  'schedule_scan':  'Schedule scan',
  'card_click':     'Card click',
  'modal_verify':   'Modal verify',
  'booking':        'Registration',
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
  booked:             'Registered',
  waitlist:           'Waitlisted',        // Stage 8: bot writes 'waitlist' (not 'waitlisted')
  waitlisted:         'Waitlisted',        // keep for legacy data
  success:            'Preflight Passed',  // Stage 8: pre-window bot run found class bookable
  dry_run:            'Simulated',
  found_not_open_yet: 'Not Open Yet',
  not_found:          'Class Not Found',
  full:               'Class Full',
  closed:             'Registration Closed',
  already_registered: 'Already Registered', // Stage 9: settled positive state — not a failure
  stale_state:        'Already Cleared',    // Stage 1: YMCA already removed enrollment; local was stale
  failed:             'Failed',
  error:              'Needs Review',      // Stage 9: technical error — softer than "Error"
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

// Returns the correct URL for a screenshot reference stored in the DB.
// New-style refs contain a "/" (e.g. "2026-04-10/job1_scan_class_not_found_...png")
// and are served via /api/screenshots/. Legacy refs are plain basenames served via /screenshots/.
function screenshotSrc(ref: string | null | undefined): string | null {
  if (!ref) return null
  return ref.includes('/') ? `/api/screenshots/${ref}` : `/screenshots/${ref}`
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
                  src={screenshotSrc(ev.screenshot) ?? ''}
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

// Stage 7: verdict badge colours
//   green  — ready / found / reachable
//   amber  — informational (full, closed, waitlist, not_open_yet, not_available)
//   red    — hard error (login_required treated as blockage; anything else unknown)
const VERDICT_LABELS: Record<string, string> = {
  ready:        'ready',
  found:        'found',
  reachable:    'reachable',
  waitlist_only:'waitlist only',
  not_open_yet: 'not open yet',
  not_available:'not available',
  full:         'class full',
  closed:       'closed',
  cancel_only:  'already registered',
  login_required:'login required',
  unknown:      'unknown',
}
function CheckNowVerdictBadge({ verdict }: { verdict: string }) {
  const isGreen  = verdict === 'ready' || verdict === 'found' || verdict === 'reachable'
  const isAmber  = verdict === 'waitlist_only' || verdict === 'not_open_yet'
                || verdict === 'not_available'  || verdict === 'full'
                || verdict === 'closed'          || verdict === 'cancel_only'
  const color = isGreen  ? 'text-accent-green bg-accent-green/10'
              : isAmber  ? 'text-accent-amber bg-accent-amber/10'
              :             'text-accent-red bg-accent-red/10'
  const display = VERDICT_LABELS[verdict] ?? verdict.replace(/_/g, ' ')
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0 ${color}`}>
      {display}
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
                src={screenshotSrc(modalDetail.screenshot) ?? ''}
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
            summary={(() => {
              // Stage 7: prefer classifier label over raw "UNKNOWN_ACTION" for full/closed
              const classified = actionDetail.actionStateClassified
              if (classified === 'full')             return 'class full — no spots or waitlist'
              if (classified === 'closed')           return 'registration closed by YMCA'
              if (classified === 'waitlist_available') return 'waitlist available'
              if (classified === 'already_registered') return 'already registered (cancel visible)'
              if (actionDetail.actionState && actionDetail.actionState !== 'UNKNOWN_ACTION')
                return actionDetail.actionState.replace(/_/g, ' ').toLowerCase()
              return (actionDetail.detail ?? '').slice(0, 65)
            })()}
            expanded={expandedPhase === 'action'}
            onToggle={() => toggle('action')}
          >
            {actionDetail.detail               && <KVRow label="Result"      value={actionDetail.detail} />}
            {/* Stage 7: classifier result — more readable than raw actionState */}
            {actionDetail.actionStateClassified && (
              <KVRow label="Classified as"  value={actionDetail.actionStateClassified.replace(/_/g, ' ')} />
            )}
            {actionDetail.actionState          && <KVRow label="Raw state"   value={actionDetail.actionState} mono />}
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
      return { label: 'Registered',           reason: 'Spot reserved successfully',                            color: 'text-accent-green', dot: 'bg-accent-green' }
    // Stage 8: bot writes 'waitlist' (not 'waitlisted'); keep 'waitlisted' for legacy data
    case 'waitlist':
    case 'waitlisted':
      return { label: 'Waitlisted',           reason: 'Added to the waitlist',                                 color: 'text-accent-blue',  dot: 'bg-accent-blue'  }
    // Stage 8: 'success' = preflight passed (class is bookable); NOT a failed result
    case 'success':
      return { label: 'Preflight Passed',     reason: 'Class confirmed bookable — bot will register at open',  color: 'text-accent-green', dot: 'bg-accent-green' }
    case 'dry_run':
      return { label: 'Simulated',            reason: 'Simulated registration (test mode)',                    color: 'text-accent-blue',  dot: 'bg-accent-blue'  }
    case 'found_not_open_yet':
      return { label: 'Not Open Yet',         reason: 'Registration not open yet — will retry at window open', color: 'text-text-muted',   dot: 'bg-text-muted'   }
    case 'not_found':
      return { label: 'Not Found',            reason: 'Class not found on schedule — check class name',        color: 'text-accent-amber', dot: 'bg-accent-amber'  }
    case 'full':
      return { label: 'Class Full',           reason: 'No spots or waitlist available — booking unavailable',  color: 'text-accent-amber', dot: 'bg-accent-amber'  }
    case 'waitlist_only':
      return { label: 'Waitlist Only',        reason: 'Class is full — bot will join the waitlist',            color: 'text-accent-amber', dot: 'bg-accent-amber'  }
    case 'closed':
      return { label: 'Registration Closed',  reason: 'YMCA has closed registration for this class',           color: 'text-accent-amber', dot: 'bg-accent-amber'  }
    // Stage 9: already_registered is a settled, positive state — not a failure
    case 'already_registered':
      return { label: 'Already Registered',   reason: 'Cancel button visible — you appear already registered', color: 'text-accent-green', dot: 'bg-accent-green'  }
    // Stage 1: stale_state — YMCA had already cleared the enrollment; not a booking failure
    case 'stale_state':
      return { label: 'Already Cleared',      reason: 'YMCA already removed enrollment — local state was stale', color: 'text-text-muted',   dot: 'bg-text-muted'   }
    case 'failed':
      return { label: 'Failed',               reason: 'Registration failed — see reason below',                color: 'text-accent-red',   dot: 'bg-accent-red'    }
    // Stage 9: 'error' = technical problem, not booking failure — softer label
    case 'error':
      return { label: 'Needs Review',         reason: 'A check or run encountered an error — see details',    color: 'text-accent-amber', dot: 'bg-accent-amber'  }
    case 'skipped':
      return { label: 'Skipped',             reason: 'Class skipped — already booked or paused',              color: 'text-text-muted',   dot: 'bg-text-muted'   }
    default:
      return { label: 'Unknown',             reason: 'Outcome not recognized — check Tools for details',      color: 'text-text-muted',   dot: 'bg-text-muted'   }
  }
}

interface JobLike {
  id: number
  class_title: string
  last_run_at: string | null
  last_result: string | null
  last_error_message: string | null
}

function LastRunSummaryCard({ lastRunJob, botStatus, screenshot, onViewScreenshot }: {
  lastRunJob:        JobLike | null
  botStatus:         BotStatus | null
  screenshot:        string | null
  onViewScreenshot?: (src: string) => void
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
    ? (lastRunJob.last_error_message.length > 80
        ? lastRunJob.last_error_message.slice(0, 80) + '…'
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
          <p className="text-[15px] font-semibold text-text-primary truncate">{lastRunJob.class_title}</p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
            <span className={`text-[13px] font-medium ${color}`}>{label}</span>
            <span className="text-[12px] text-text-muted">· {fmtStr(lastRunJob.last_run_at)}</span>
          </div>
          <p className="text-[12px] text-text-secondary mt-0.5 truncate">{reason}</p>
        </div>
        <ChevronIcon rotated={expanded} />
      </button>

      {/* ── Expanded detail ─────────────────────────────────── */}
      {expanded && (
        <div className="border-t border-divider">
          <DetailRow
            label="Result"
            value={lastRunJob.last_result ? (RESULT_LABELS[lastRunJob.last_result] ?? lastRunJob.last_result) : '—'}
            last={!lastRunJob.last_error_message && !screenshot}
          />
          {lastRunJob.last_error_message && (
            <DetailRow label="Reason" value={lastRunJob.last_error_message} last={!screenshot} />
          )}
          {screenshot && (
            <button
              onClick={() => onViewScreenshot?.(screenshot)}
              className="block w-full px-4 pb-4 pt-3 text-left"
            >
              <p className="text-[12px] text-text-muted mb-2 flex items-center gap-1">
                View screenshot <CameraIcon />
              </p>
              <img
                src={screenshot}
                alt="Screenshot"
                className="w-full rounded-lg border border-divider"
                loading="lazy"
              />
            </button>
          )}
        </div>
      )}
    </Card>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function ToolsScreen({ appState, selectedJobId, refresh, onAccount, accountAttention, authStatus, scrollTo, tab = 'tools', onTabChange = () => {}, scrolled = false }: ToolsScreenProps) {
  const selectedJob = appState.jobs.find(j => j.id === selectedJobId) ?? appState.jobs[0] ?? null
  const scrolledRef = useRef<string | undefined>(undefined)

  const [failures, setFailures]           = useState<FailureData | null>(null)
  const [techExpanded, setTechExpanded]     = useState(false)
  const [botStatus, setBotStatus]         = useState<BotStatus | null>(null)
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(null)
  const [sniperRunState, setSniperRunState] = useState<SniperRunState | null>(null)
  const [expandedKey, setExpandedKey]         = useState<string | null>(null)
  const [activityShowAll, setActivityShowAll]   = useState(false)
  const [lightboxSrc, setLightboxSrc]         = useState<string | null>(null)

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

  // ── Schedule cache / classifier result ────────────────────────────────────
  const [classifierResult, setClassifierResult] = useState<ClassTruthResult | null>(null)

  useEffect(() => {
    api.getFailures().then(setFailures).catch(() => {})
    api.getStatus().then(setBotStatus).catch(() => {})
    api.getSessionStatus().then(setSessionStatus).catch(() => {})
    api.getSniperState().then(setSniperRunState).catch(() => {})
    api.getAutoPreflightConfig().then(setAutoPreflightConfig).catch(() => {})
    api.getSessionKeepaliveConfig().then(setKeepaliveConfig).catch(() => {})
  }, [])

  useEffect(() => {
    if (!selectedJobId) return
    api.classifyJob(selectedJobId).then(setClassifierResult).catch(() => setClassifierResult(null))
  }, [selectedJobId])

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
      <AppHeader subtitle="Tools" onAccount={onAccount} accountAttention={accountAttention} authStatus={authStatus} tab={tab} onTabChange={onTabChange} scrolled={scrolled} />
      <ScreenContainer>

        {/* ── Last Run (compact, tap to expand) ───────────── */}
        <SectionHeader title="Last Run" id="tools-last-run" />
        <LastRunSummaryCard
          lastRunJob={lastRunJob}
          botStatus={botStatus}
          screenshot={screenshotSrc(sniperRunState?.screenshotPath)}
          onViewScreenshot={setLightboxSrc}
        />

        {/* ── Failure Insights ──────────────────────────────── */}
        {(() => {
          // Cause data: prefer h24, fall back to d7
          const h24Data   = failures?.trends?.h24
          const d7Data    = failures?.trends?.d7
          const causeData = (h24Data?.total ?? 0) > 0 ? h24Data : d7Data
          const causeWin  = (h24Data?.total ?? 0) > 0 ? '24h' : '7d'
          const topCauses = (causeData?.byReason ?? []).slice(0, 5)

          // Session / health alerts
          type Alert = { title: string; detail: string; color: 'red' | 'amber' }
          const alerts: Alert[] = []

          if (sessionStatus?.daxko === 'AUTH_NEEDS_LOGIN')
            alerts.push({ title: 'Session needs login', detail: 'Tap the account icon to sign in.', color: 'red' })

          if (sessionStatus?.familyworks === 'FAMILYWORKS_SESSION_MISSING' ||
              sessionStatus?.familyworks === 'FAMILYWORKS_SESSION_EXPIRED')
            alerts.push({ title: 'Schedule session unavailable', detail: 'Tap the account icon to reconnect.', color: 'red' })

          if (autoPreflightConfig?.lastRun?.status === 'fail')
            alerts.push({ title: 'Last preflight failed', detail: 'Use Preflight in the Now tab to re-verify.', color: 'amber' })

          if (keepaliveConfig?.lastRun?.valid === false)
            alerts.push({ title: 'Session check failed', detail: 'A new check will run shortly.', color: 'amber' })

          if (alerts.length === 0 && topCauses.length === 0) return null

          return (
            <>
              <SectionHeader title={alerts.length === 0 ? `Failure Insights · ${causeWin}` : 'Failure Insights'} />
              <Card padding="none">
                {/* Alerts */}
                {alerts.map((a, i) => {
                  const last = i === alerts.length - 1 && topCauses.length === 0
                  return (
                    <div key={i} className={`flex items-start gap-3 px-4 py-3 ${last ? '' : 'border-b border-divider'}`}>
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 mt-[5px] ${a.color === 'red' ? 'bg-accent-red' : 'bg-accent-amber'}`} />
                      <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-text-primary">{a.title}</p>
                        <p className="text-[12px] text-text-secondary mt-0.5">{a.detail}</p>
                      </div>
                    </div>
                  )
                })}

                {/* Top causes sub-header (only when alerts also present) */}
                {topCauses.length > 0 && alerts.length > 0 && (
                  <div className="px-4 pt-3 pb-1.5 border-t border-divider">
                    <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">Top causes · {causeWin}</p>
                  </div>
                )}

                {/* Cause rows */}
                {topCauses.map((r, i) => (
                  <div
                    key={r.reason}
                    className={`flex items-center justify-between px-4 py-2.5 ${i < topCauses.length - 1 ? 'border-b border-divider' : ''}`}
                  >
                    <p className="text-[13px] text-text-primary">{REASON_LABELS[r.reason] ?? r.reason}</p>
                    <span className="text-[13px] font-semibold text-text-secondary ml-3 flex-shrink-0">— {r.count}</span>
                  </div>
                ))}
              </Card>
            </>
          )
        })()}

        {/* ── Failure Trends ────────────────────────────────── */}
        {failures !== null && (() => {
          const h1Total  = failures?.trends?.h1?.total  ?? 0
          const h6Total  = failures?.trends?.h6?.total  ?? 0
          const h24Total = failures?.trends?.h24?.total ?? 0

          // Direction: compare last-hour rate vs 24h hourly average
          const h24HourlyAvg = h24Total / 24
          let direction: string | null = null
          let dirColor = ''
          let dirArrow = ''
          if (failures?.trends?.h24) {
            if (h1Total === 0 && h24Total === 0) {
              direction = 'Stable'; dirColor = 'text-text-muted'; dirArrow = '→'
            } else if (h1Total === 0 && h24HourlyAvg > 0) {
              direction = 'Improving'; dirColor = 'text-accent-green'; dirArrow = '↓'
            } else if (h24HourlyAvg === 0 || h1Total > h24HourlyAvg * 1.5) {
              direction = 'Worsening'; dirColor = 'text-accent-red'; dirArrow = '↑'
            } else if (h1Total < h24HourlyAvg * 0.75) {
              direction = 'Improving'; dirColor = 'text-accent-green'; dirArrow = '↓'
            } else {
              direction = 'Stable'; dirColor = 'text-text-muted'; dirArrow = '→'
            }
          }

          const rows = [
            { label: 'Last hour',     count: h1Total  },
            { label: 'Last 6 hours',  count: h6Total  },
            { label: 'Last 24 hours', count: h24Total },
          ]

          return (
            <>
              <SectionHeader title="Failure Trends" />
              <Card padding="none">
                {/* Direction header */}
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-divider">
                  <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">Failures</span>
                  {direction && (
                    <span className={`text-[12px] font-semibold ${dirColor}`}>{dirArrow} {direction}</span>
                  )}
                </div>
                {/* Window rows */}
                {rows.map((r, i) => (
                  <div
                    key={r.label}
                    className={`flex items-center justify-between px-4 py-2.5 ${i < rows.length - 1 ? 'border-b border-divider' : ''}`}
                  >
                    <span className="text-[13px] text-text-secondary">{r.label}</span>
                    <span className={`text-[13px] font-semibold ${r.count > 0 ? 'text-accent-red' : 'text-text-muted'}`}>
                      {r.count === 0 ? 'None' : r.count}
                    </span>
                  </div>
                ))}
              </Card>
            </>
          )
        })()}

        {/* ── Per-Class Reliability ────────────────────────── */}
        {(() => {
          const activeJobs = appState.jobs.filter(j => j.is_active)
          if (activeJobs.length === 0) return null

          const byJobMap = new Map((failures?.byJob ?? []).map(r => [r.job_id, r]))

          // Compute risk score for sorting: more failures = worse
          const scored = activeJobs.map(job => {
            const rel    = byJobMap.get(job.id)
            const fails  = rel?.failure_count ?? 0
            const isDown = job.last_result === 'failed' || job.last_result === 'error'
            return { job, rel, fails, isDown, score: fails * 10 + (isDown ? 5 : 0) }
          })
          scored.sort((a, b) => b.score - a.score)

          return (
            <>
              <SectionHeader title="Per-Class Reliability" />
              <Card padding="none">
                {scored.map(({ job, rel, fails, isDown }, i) => {
                  const neverRun = !job.last_result

                  // Status: worst condition wins
                  let dot: string, statusText: string, statusColor: string
                  if (fails >= 3 || isDown) {
                    dot = 'bg-accent-red';   statusText = 'At risk'; statusColor = 'text-accent-red'
                  } else if (fails >= 1) {
                    dot = 'bg-accent-amber'; statusText = 'Issue';   statusColor = 'text-accent-amber'
                  } else if (neverRun) {
                    dot = 'bg-divider';      statusText = 'Not run'; statusColor = 'text-text-muted'
                  } else {
                    dot = 'bg-accent-green'; statusText = 'Healthy'; statusColor = 'text-accent-green'
                  }

                  const lastLabel = job.last_result
                    ? (RESULT_LABELS[job.last_result] ?? job.last_result)
                    : 'No runs'
                  const topIssue = rel?.top_reason
                    ? (REASON_LABELS[rel.top_reason] ?? rel.top_reason)
                    : null

                  return (
                    <div key={job.id} className={`px-4 py-3 ${i < scored.length - 1 ? 'border-b border-divider' : ''}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          <div className={`w-2 h-2 rounded-full flex-shrink-0 mt-[5px] ${dot}`} />
                          <p className="text-[14px] font-semibold text-text-primary truncate">{job.class_title}</p>
                        </div>
                        <span className={`text-[12px] font-semibold flex-shrink-0 mt-0.5 ${statusColor}`}>{statusText}</span>
                      </div>
                      <div className="ml-[18px] mt-0.5 flex items-center gap-2 flex-wrap">
                        <span className="text-[12px] text-text-secondary">Last: {lastLabel}</span>
                        {fails > 0 && (
                          <span className="text-[12px] text-accent-red">· {fails} failure{fails === 1 ? '' : 's'} / 7d</span>
                        )}
                        {topIssue && (
                          <span className="text-[12px] text-text-muted truncate">· {topIssue}</span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </Card>
            </>
          )
        })()}

        {/* ── Recent Failures ───────────────────────────────── */}
        {recentFailures.length > 0 && (
          <>
            <SectionHeader title="Recent Failures" />
            <Card padding="none">
              {(() => {
                const PAGE = 5
                const MAX  = 10
                const capped  = recentFailures.slice(0, MAX)
                const visible = activityShowAll ? capped : capped.slice(0, PAGE)
                const canMore = !activityShowAll && capped.length > PAGE
                const moreCount = capped.length - PAGE

                return (
                  <>
                    {visible.map((f, i) => {
                      const entryKey = f.id != null ? String(f.id) : f.occurred_at
                      const isOpen   = expandedKey === entryKey
                      const reason   = f.label ?? REASON_LABELS[f.reason] ?? f.reason

                      return (
                        <div key={entryKey}>
                          {/* ── Collapsed row ──────────────── */}
                          <button
                            onClick={() => setExpandedKey(isOpen ? null : entryKey)}
                            className="w-full flex items-center justify-between px-4 py-3 text-left active:bg-divider/40 transition-colors"
                          >
                            <div className="flex-1 mr-3 min-w-0">
                              {f.class_title && (
                                <p className="text-[12px] text-text-muted truncate">{f.class_title}</p>
                              )}
                              <p className="flex items-center gap-1 text-[14px] font-medium text-text-primary">
                                <span className="truncate">{reason}</span>
                                {f.screenshot && (
                                  <span title="Screenshot available" className="inline-flex flex-shrink-0">
                                    <CameraIcon />
                                  </span>
                                )}
                              </p>
                              <p className="text-[12px] text-text-muted mt-0.5">{fmtStr(f.occurred_at)}</p>
                            </div>
                            <ChevronIcon rotated={isOpen} />
                          </button>

                          {/* ── Expanded detail ────────────── */}
                          {isOpen && (
                            <div className="px-4 pb-4 space-y-3">
                              {f.message && (
                                <div className="bg-surface rounded-lg p-3 border border-divider">
                                  <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wide mb-1">Reason</p>
                                  <p className="text-[12px] text-text-secondary leading-relaxed break-words">{f.message}</p>
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
                              {f.screenshot ? (
                                <button
                                  onClick={() => { const s = screenshotSrc(f.screenshot); if (s) setLightboxSrc(s) }}
                                  className="block w-full text-left"
                                >
                                  <p className="text-[12px] text-text-muted mb-2 flex items-center gap-1">
                                    View screenshot <CameraIcon />
                                  </p>
                                  <img
                                    src={screenshotSrc(f.screenshot) ?? ''}
                                    alt="Screenshot"
                                    className="w-full rounded-xl border border-divider"
                                    loading="lazy"
                                  />
                                </button>
                              ) : (
                                <p className="text-[12px] text-text-muted">No screenshot</p>
                              )}
                            </div>
                          )}

                          {i < visible.length - 1 && <div className="h-px bg-divider mx-4" />}
                        </div>
                      )
                    })}

                    {/* ── Show more / collapse ────────────── */}
                    {(canMore || activityShowAll) && (
                      <>
                        <div className="h-px bg-divider mx-4" />
                        <button
                          onClick={() => setActivityShowAll(s => !s)}
                          className="w-full px-4 py-3 text-left active:bg-divider/40 transition-colors"
                        >
                          <span className="text-[13px] font-medium text-accent-blue">
                            {activityShowAll ? 'Show less' : `Show ${moreCount} more`}
                          </span>
                        </button>
                      </>
                    )}
                  </>
                )
              })()}
            </Card>
          </>
        )}

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
              return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
            })() : null

            let apfHealth = 'Off'
            let apfDot    = 'bg-divider'
            let apfColor  = 'text-text-muted'
            if (cfg?.enabled) {
              if (!cfg.lastRun)                         { apfHealth = 'On'; apfDot = 'bg-accent-blue'; apfColor = 'text-text-muted' }
              else if (cfg.lastRun.status === 'pass')   { apfHealth = 'Healthy'; apfDot = 'bg-accent-green'; apfColor = 'text-accent-green' }
              else if (cfg.lastRun.status === 'fail')   { apfHealth = 'Failed';  apfDot = 'bg-accent-red';   apfColor = 'text-accent-red'   }
              else                                      { apfHealth = 'Review';  apfDot = 'bg-accent-amber'; apfColor = 'text-accent-amber' }
            }

            return (
              <button
                onClick={handleAutoPreflightToggle}
                disabled={apfToggling || cfg === null}
                className="flex items-center justify-between w-full px-4 py-3 text-left active:opacity-60 transition-opacity border-b border-divider"
              >
                <div className="flex-1 mr-4 min-w-0">
                  <p className="text-[13px] font-medium text-text-primary leading-tight">
                    {apfToggling ? 'Updating…' : 'Auto Preflight'}
                  </p>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${apfDot}`} />
                    <span className={`text-[12px] ${apfColor}`}>{apfHealth}</span>
                    {apfNext && <span className="text-[12px] text-text-muted">· next {apfNext}</span>}
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
              return kaMs < 60_000 ? 'now' : h > 0 ? `${h}h ${m}m` : `${m}m`
            })() : null

            let kaHealth = 'Off'
            let kaDot    = 'bg-divider'
            let kaColor  = 'text-text-muted'
            if (cfg?.enabled) {
              if (!cfg.lastRun)              { kaHealth = 'On';      kaDot = 'bg-accent-blue';  kaColor = 'text-text-muted'   }
              else if (cfg.lastRun.valid)    { kaHealth = 'Healthy'; kaDot = 'bg-accent-green'; kaColor = 'text-accent-green' }
              else                           { kaHealth = 'Failed';  kaDot = 'bg-accent-red';   kaColor = 'text-accent-red'   }
            }

            return (
              <button
                onClick={handleKeepaliveToggle}
                disabled={kaToggling || cfg === null}
                className="flex items-center justify-between w-full px-4 py-3 text-left active:opacity-60 transition-opacity"
              >
                <div className="flex-1 mr-4 min-w-0">
                  <p className="text-[13px] font-medium text-text-primary leading-tight">
                    {kaToggling ? 'Updating…' : 'Session Check'}
                  </p>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${kaDot}`} />
                    <span className={`text-[12px] ${kaColor}`}>{kaHealth}</span>
                    {kaNext && <span className="text-[12px] text-text-muted">· next {kaNext}</span>}
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

        {/* ── Technical Details (collapsible) ─────────────── */}
        {(() => {
          const { label: daxkoLabel } = daxkoToLabel(sessionStatus?.daxko)
          const { label: fwLabel }    = fwToLabel(sessionStatus?.familyworks)
          const evCount = sniperRunState?.events?.length ?? 0
          const techSummary = [
            `Session: ${daxkoLabel}`,
            `Schedule: ${fwLabel}`,
            evCount > 0 ? `${evCount} event${evCount === 1 ? '' : 's'}` : null,
          ].filter(Boolean).join(' · ')

          return (
            <>
              <Card padding="none">
                <button
                  onClick={() => setTechExpanded(e => !e)}
                  className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left active:bg-divider/40 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium text-text-muted">Technical Details</p>
                    <p className="text-[12px] text-text-muted/70 mt-0.5 truncate">{techSummary}</p>
                  </div>
                  <ChevronIcon rotated={techExpanded} />
                </button>
              </Card>

              {techExpanded && (
                <div className="space-y-4">
                  {/* Readiness */}
                  <SectionHeader title="Readiness" id="tools-readiness" />
                  <Card padding="none">
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
                    {sniperRunState?.bundle && (
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
                    {sniperRunState?.bundle && sniperRunState.bundle.modal && (
                      <div className="flex items-center justify-between px-4 py-3 border-b border-divider">
                        <span className="text-[14px] text-text-secondary">Modal</span>
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${bundleDot(sniperRunState.bundle.modal)}`} />
                          <span className="text-[14px] font-medium text-text-primary">
                            {MODAL_LABEL[sniperRunState.bundle.modal as keyof typeof MODAL_LABEL]
                              ?? sniperRunState.bundle.modal}
                          </span>
                        </div>
                      </div>
                    )}
                    {sniperRunState?.bundle && (
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
                    <div className="flex items-center justify-between px-4 py-3">
                      <span className="text-[14px] text-text-secondary">Last checked</span>
                      <span className="text-[13px] text-text-muted">
                        {sniperRunState?.runId ? fmtStr(sniperRunState.runId) : sessionStatus?.lastVerified ? fmtStr(sessionStatus.lastVerified) : '—'}
                      </span>
                    </div>
                  </Card>

                  {/* Run Events */}
                  <SectionHeader
                    id="tools-run-events"
                    title={`Run Events${sniperRunState?.events?.length ? ` · ${sniperRunState.events.length}` : ''}`}
                  />
                  <LastRunEvents sniperRunState={sniperRunState} />

                  {/* Last Check Now (per-phase diagnostics) */}
                  <LastCheckNowSection sniperRunState={sniperRunState} />

                  {/* Schedule Cache (classifier result for selected job) */}
                  {selectedJob && classifierResult && classifierResult.fetchedAt && (() => {
                    const cr  = classifierResult
                    const st  = cr.state
                    const dot =
                      st === 'bookable'           ? 'bg-accent-green' :
                      st === 'waitlist_available' ? 'bg-accent-amber' :
                      st === 'full'               ? 'bg-accent-red'   :
                      st === 'not_found'          ? 'bg-text-muted'   : 'bg-divider'
                    return (
                      <>
                        <SectionHeader title="Schedule Cache" id="tools-cache" />
                        <Card padding="none">
                          <div className="flex items-center gap-2 px-4 py-3 border-b border-divider">
                            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
                            <span className="text-[13px] font-semibold text-text-primary">
                              {CLASS_STATE_LABEL[st]}
                            </span>
                            {cr.openSpots != null && (
                              <span className="text-[12px] text-text-secondary ml-auto">
                                {cr.openSpots} / {cr.totalCapacity ?? '?'} open
                              </span>
                            )}
                          </div>
                          {cr.reason     && <KVRow label="Reason"     value={cr.reason} />}
                          {cr.matchType !== 'none' && (
                            <KVRow label="Match"   value={`${cr.matchType} · conf ${cr.confidence}`} />
                          )}
                          {cr.isFuzzyMatch && cr.matchedClassName && (
                            <KVRow label="Matched as"  value={cr.matchedClassName} />
                          )}
                          {cr.matchedTime && (
                            <KVRow label="Time"        value={cr.matchedTime} />
                          )}
                          {cr.matchedInstructor && (
                            <KVRow label="Instructor"  value={cr.matchedInstructor} />
                          )}
                          <KVRow label="Fetched"       value={fmtStr(cr.fetchedAt!)} />
                        </Card>
                      </>
                    )
                  })()}
                </div>
              )}
            </>
          )
        })()}
      </ScreenContainer>

      <ScreenshotLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
    </>
  )
}

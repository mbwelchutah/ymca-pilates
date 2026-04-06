import { useState, useEffect, useRef, useCallback } from 'react'
import type { ReplaySummary, ReplayRunMeta, ReplayEventType } from '../lib/replayEvent'
import { REPLAY_ICON, REPLAY_TERMINAL_TYPES } from '../lib/replayEvent'
import { api } from '../lib/api'

// ── Helpers ──────────────────────────────────────────────────────────────────

function relTime(iso: string, _tick: number): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 0)          return 'just now'
  const s = Math.floor(diff / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (s < 5)  return 'just now'
  if (s < 60) return `${s}s ago`
  if (m < 60) return `${m}m ago`
  if (h < 24) return `${h}h ago`
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function absTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(iso))
  } catch { return '—' }
}

/** Short chip label: "Apr 6, 10:20 AM" */
function chipTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(iso))
  } catch { return '?' }
}

type DotTone = 'green' | 'amber' | 'red' | 'blue' | 'gray'

function eventTone(type: ReplayEventType): DotTone {
  switch (type) {
    case 'success':         return 'green'
    case 'confirm':         return 'green'
    case 'waitlist':        return 'amber'
    case 'retry':           return 'amber'
    case 'failure':         return 'red'
    case 'window_open':     return 'blue'
    case 'target_acquired': return 'blue'
    case 'modal_opened':    return 'blue'
    case 'action_attempt':  return 'blue'
    default:                return 'gray'
  }
}

function outcomeTone(outcome: string): DotTone {
  if (outcome === 'success')  return 'green'
  if (outcome === 'waitlist') return 'amber'
  if (outcome === 'failure')  return 'red'
  return 'gray'
}

const TONE_TEXT: Record<DotTone, string> = {
  green: 'text-accent-green',
  amber: 'text-accent-amber',
  red:   'text-accent-red',
  blue:  'text-accent-blue',
  gray:  'text-text-secondary',
}

const TONE_BG: Record<DotTone, string> = {
  green: 'bg-accent-green/8',
  amber: 'bg-accent-amber/8',
  red:   'bg-accent-red/8',
  blue:  'bg-accent-blue/8',
  gray:  'bg-surface',
}

const TONE_BORDER: Record<DotTone, string> = {
  green: 'border-accent-green/40',
  amber: 'border-accent-amber/40',
  red:   'border-accent-red/40',
  blue:  'border-accent-blue/40',
  gray:  'border-divider',
}

const OUTCOME_LABEL: Record<string, { text: string; tone: DotTone }> = {
  success: { text: 'Booked',   tone: 'green' },
  waitlist:{ text: 'Waitlist', tone: 'amber' },
  failure: { text: 'Failed',   tone: 'red'   },
  unknown: { text: 'Unknown',  tone: 'gray'  },
}

const LIVE_POLL_MS = 3_000
const HISTORY_CHIPS = 5   // max past-run chips to show in the picker

// ── Props ─────────────────────────────────────────────────────────────────────

interface ReplayTimelineProps {
  jobId:            number | null
  runKey?:          string | null
  isBookingActive?: boolean
}

// ── RefreshIcon ───────────────────────────────────────────────────────────────

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      className={`w-3.5 h-3.5 ${spinning ? 'animate-spin' : ''}`}
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
      strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  )
}

// ── HistoryPicker ─────────────────────────────────────────────────────────────
// Horizontal row of chips for past runs. Only rendered when ≥2 runs exist.

function HistoryPicker({
  runs,
  selectedId,
  onSelect,
}: {
  runs:       ReplayRunMeta[]
  selectedId: string | null   // null = "latest" / most recent
  onSelect:   (runId: string | null) => void
}) {
  if (runs.length < 2) return null

  const visible = runs.slice(0, HISTORY_CHIPS)

  return (
    <div className="border-b border-divider px-4 py-2.5 flex items-center gap-2 overflow-x-auto no-scrollbar">
      <span className="text-[10px] text-text-muted shrink-0 uppercase tracking-wide">Past runs</span>
      <div className="flex items-center gap-1.5 flex-nowrap">
        {visible.map((run, i) => {
          const isSelected = selectedId === run.runId || (selectedId === null && i === 0)
          const tone       = outcomeTone(run.outcome)
          return (
            <button
              key={run.runId}
              onClick={() => onSelect(i === 0 ? null : run.runId)}
              className={[
                'flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] shrink-0 transition-colors',
                isSelected
                  ? `${TONE_BG[tone]} ${TONE_BORDER[tone]} ${TONE_TEXT[tone]} font-semibold`
                  : 'bg-surface border-divider text-text-muted',
              ].join(' ')}
            >
              {/* Outcome dot */}
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                tone === 'green' ? 'bg-accent-green' :
                tone === 'amber' ? 'bg-accent-amber' :
                tone === 'red'   ? 'bg-accent-red'   : 'bg-text-muted/40'
              }`} />
              {chipTime(run.capturedAt)}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ReplayTimeline({ jobId, runKey, isBookingActive = false }: ReplayTimelineProps) {
  const [open,        setOpen]        = useState(false)
  const [replay,      setReplay]      = useState<ReplaySummary | null>(null)
  const [history,     setHistory]     = useState<ReplayRunMeta[]>([])
  // null = show latest run; string = show that specific runId
  const [selectedId,  setSelectedId]  = useState<string | null>(null)
  const [loading,     setLoading]     = useState(false)
  const [fetched,     setFetched]     = useState(false)
  const [tick,        setTick]        = useState(0)

  const containerRef  = useRef<HTMLDivElement>(null)
  const prevActiveRef = useRef(isBookingActive)
  const prevRunKeyRef = useRef(runKey)
  const prevOpenRef   = useRef(false)

  // ── Fetch the selected run ──────────────────────────────────────────────────
  const fetchReplay = useCallback(async (showSpinner = true, runId: string | null = null) => {
    if (!jobId) return
    if (showSpinner) setLoading(true)
    try {
      const data = runId
        ? await api.fetchReplayRun(jobId, runId)
        : await api.fetchReplay(jobId)
      setReplay(data)
    } finally {
      if (showSpinner) setLoading(false)
      setFetched(true)
    }
  }, [jobId])

  // ── Fetch history index ─────────────────────────────────────────────────────
  const fetchHistory = useCallback(async () => {
    if (!jobId) return
    const { runs } = await api.fetchReplayHistory(jobId)
    setHistory(runs)
  }, [jobId])

  // ── When selectedId changes, load that specific run ─────────────────────────
  useEffect(() => {
    if (!open || !fetched) return
    fetchReplay(true, selectedId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  // ── On open (or runKey/jobId change): fetch latest + history ───────────────
  useEffect(() => {
    if (!open) return
    // Reset to latest when switching jobs or a new run key arrives
    setSelectedId(null)
    fetchReplay(true, null)
    fetchHistory()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runKey, jobId])

  // ── Clear stale data while closed ──────────────────────────────────────────
  useEffect(() => {
    if (open) return
    setFetched(false)
    setReplay(null)
    setHistory([])
    setSelectedId(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey, jobId])

  // ── Live polling during active run (latest only) ────────────────────────────
  useEffect(() => {
    if (!open || !isBookingActive || selectedId !== null) return
    const id = setInterval(() => fetchReplay(false, null), LIVE_POLL_MS)
    return () => clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isBookingActive, selectedId])

  // ── Auto-expand: booking started ────────────────────────────────────────────
  useEffect(() => {
    const wasActive = prevActiveRef.current
    prevActiveRef.current = isBookingActive

    if (isBookingActive && !wasActive) {
      setSelectedId(null)  // always show the live run
      setOpen(true)
      return
    }

    if (wasActive && !isBookingActive && open) {
      // Run finished — eager terminal fetch + refresh history
      const id = setTimeout(() => {
        fetchReplay(false, null)
        fetchHistory()
      }, 600)
      return () => clearTimeout(id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBookingActive])

  // ── Auto-expand: new run finished ───────────────────────────────────────────
  useEffect(() => {
    const prev = prevRunKeyRef.current
    prevRunKeyRef.current = runKey
    if (runKey && runKey !== prev && prev !== undefined) {
      setSelectedId(null)
      setOpen(true)
    }
  }, [runKey])

  // ── Scroll into view on open ────────────────────────────────────────────────
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      requestAnimationFrame(() => {
        containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      })
    }
    prevOpenRef.current = open
  }, [open])

  // ── Timestamp tick ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => setTick(t => t + 1), 1_000)
    return () => clearInterval(id)
  }, [open])

  if (!jobId) return null

  const outcome   = replay ? OUTCOME_LABEL[replay.outcome] ?? OUTCOME_LABEL.unknown : null
  // True when viewing the live/latest run (not a historical one)
  const isLatest  = selectedId === null

  return (
    <div ref={containerRef} className="rounded-2xl overflow-hidden border border-divider bg-background">

      {/* ── Header toggle ────────────────────────────────────────────────── */}
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 active:opacity-60 transition-opacity"
      >
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-text-secondary">Last booking run</span>

          {/* Live pulse */}
          {isBookingActive && isLatest && (
            <span className="flex items-center gap-1 text-[11px] text-accent-blue font-medium">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-blue opacity-60" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-accent-blue" />
              </span>
              Live
            </span>
          )}

          {/* Outcome badge */}
          {outcome && !(isBookingActive && isLatest) && !loading && (
            <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded-md ${TONE_TEXT[outcome.tone]} ${TONE_BG[outcome.tone]}`}>
              {outcome.text}
            </span>
          )}

          {/* History run count badge */}
          {!open && history.length >= 2 && !isBookingActive && (
            <span className="text-[10px] text-text-muted">
              {history.length} run{history.length !== 1 ? 's' : ''}
            </span>
          )}

          {loading && (
            <svg className="animate-spin h-3 w-3 text-text-muted" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!open && !(isBookingActive && isLatest) && replay?.capturedAt && (
            <span className="text-[11px] text-text-muted tabular-nums">
              {absTime(replay.capturedAt)}
            </span>
          )}
          <span className="text-[11px] text-text-muted select-none">{open ? '↑' : '↓'}</span>
        </div>
      </button>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      {open && (
        <div className="border-t border-divider">

          {/* ── History picker ──────────────────────────────────────────── */}
          <HistoryPicker
            runs={history}
            selectedId={selectedId}
            onSelect={id => {
              setSelectedId(id)
            }}
          />

          {/* In-progress: booking active, no events yet */}
          {isBookingActive && isLatest && fetched && (!replay || replay.events.length === 0) && (
            <div className="px-4 py-4 flex items-center gap-2.5">
              <svg className="animate-spin h-3.5 w-3.5 text-accent-blue flex-shrink-0" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
              <span className="text-[13px] text-accent-blue">Booking in progress — capturing events…</span>
            </div>
          )}

          {/* Empty: idle, no data */}
          {!isBookingActive && fetched && !replay && (
            <div className="px-4 py-5 text-center">
              <p className="text-[13px] text-text-muted">No run recorded yet</p>
              <p className="text-[11px] text-text-muted mt-1 opacity-70">
                A replay will appear after the first automatic booking attempt.
              </p>
            </div>
          )}

          {/* Event list */}
          {replay && replay.events.length > 0 && (
            <div className="relative">
              <div className="absolute left-[27px] top-0 bottom-0 w-px bg-divider" aria-hidden="true" />

              {replay.events.map((evt, idx) => {
                const tone       = eventTone(evt.type)
                const isTerminal = REPLAY_TERMINAL_TYPES.has(evt.type)
                const isLast     = idx === replay.events.length - 1
                const icon       = REPLAY_ICON[evt.type]

                return (
                  <div
                    key={idx}
                    className={[
                      'relative flex items-start gap-3 px-4 py-2.5',
                      isTerminal ? TONE_BG[tone] : '',
                      !isLast    ? 'border-b border-divider/50' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    <div className="relative z-10 flex-shrink-0 mt-0.5">
                      <span className={`flex items-center justify-center w-7 h-7 rounded-full text-[13px]
                        ${isTerminal ? TONE_BG[tone] : 'bg-background'} border border-divider`}>
                        {icon}
                      </span>
                    </div>

                    <div className="flex-1 min-w-0 pt-0.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className={`text-[13px] font-medium leading-snug ${isTerminal ? TONE_TEXT[tone] : 'text-text-primary'}`}>
                          {evt.label}
                        </span>
                        <span className="text-[10px] text-text-muted tabular-nums shrink-0">
                          {relTime(evt.timestamp, tick)}
                        </span>
                      </div>
                      {evt.detail && (
                        <p className="text-[11px] text-text-muted mt-0.5 leading-snug truncate">
                          {evt.detail}
                        </p>
                      )}
                    </div>
                  </div>
                )
              })}

              {/* Trailing live indicator */}
              {isBookingActive && isLatest && (
                <div className="relative flex items-center gap-3 px-4 py-2.5">
                  <div className="relative z-10 flex-shrink-0">
                    <span className="flex items-center justify-center w-7 h-7 rounded-full bg-background border border-divider">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-blue opacity-60" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-accent-blue" />
                      </span>
                    </span>
                  </div>
                  <span className="text-[12px] text-accent-blue">Waiting for next event…</span>
                </div>
              )}
            </div>
          )}

          {/* Footer — metadata + refresh */}
          {!(isBookingActive && isLatest) && fetched && (
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-divider bg-surface/50">
              <span className="text-[11px] text-text-muted">
                {replay
                  ? `${replay.events.length} event${replay.events.length !== 1 ? 's' : ''}`
                  : 'No data'}
              </span>
              <div className="flex items-center gap-3">
                {replay?.capturedAt && (
                  <span className="text-[11px] text-text-muted tabular-nums">
                    {absTime(replay.capturedAt)}
                  </span>
                )}
                <button
                  onClick={e => { e.stopPropagation(); fetchReplay(true, selectedId) }}
                  disabled={loading}
                  title="Refresh"
                  className="text-text-muted active:opacity-50 disabled:opacity-30 transition-opacity"
                >
                  <RefreshIcon spinning={loading} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

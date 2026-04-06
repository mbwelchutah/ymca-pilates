import { useState, useEffect, useRef, useCallback } from 'react'
import type { ReplaySummary, ReplayEventType } from '../lib/replayEvent'
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

const OUTCOME_LABEL: Record<string, { text: string; tone: DotTone }> = {
  success: { text: 'Booked',   tone: 'green' },
  waitlist:{ text: 'Waitlist', tone: 'amber' },
  failure: { text: 'Failed',   tone: 'red'   },
  unknown: { text: 'Unknown',  tone: 'gray'  },
}

// ── Live-poll interval while a booking is in flight ───────────────────────────
const LIVE_POLL_MS = 3_000

// ── Props ─────────────────────────────────────────────────────────────────────

interface ReplayTimelineProps {
  jobId:           number | null
  runKey?:         string | null   // changes when a run finishes → triggers re-fetch
  isBookingActive?: boolean        // true while a booking attempt is in flight
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ReplayTimeline({ jobId, runKey, isBookingActive = false }: ReplayTimelineProps) {
  const [open,          setOpen]          = useState(false)
  const [replay,        setReplay]        = useState<ReplaySummary | null>(null)
  const [loading,       setLoading]       = useState(false)
  const [fetched,       setFetched]       = useState(false)
  // Tick counter — increments every second while open to keep relative timestamps live
  const [tick,          setTick]          = useState(0)
  // Track previous isBookingActive to detect the active→idle transition
  const prevActiveRef = useRef(isBookingActive)

  // ── Core fetch (background-safe: only shows spinner on first load) ──────────
  const fetchReplay = useCallback(async (showSpinner = true) => {
    if (!jobId) return
    if (showSpinner) setLoading(true)
    try {
      const data = await api.fetchReplay(jobId)
      setReplay(data)
    } finally {
      if (showSpinner) setLoading(false)
      setFetched(true)
    }
  }, [jobId])

  // ── Fetch on open / runKey change / jobId change ────────────────────────────
  useEffect(() => {
    if (!open) return
    fetchReplay(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runKey, jobId])

  // ── Clear stale data when key changes while closed ──────────────────────────
  useEffect(() => {
    if (open) return
    setFetched(false)
    setReplay(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey, jobId])

  // ── Live polling — 3 s interval while open AND booking is active ────────────
  useEffect(() => {
    if (!open || !isBookingActive) return
    const id = setInterval(() => fetchReplay(false), LIVE_POLL_MS)
    return () => clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isBookingActive])

  // ── Eager terminal fetch — fires the moment booking transitions to idle ──────
  // Captures the terminal event (success/waitlist/failure) immediately instead
  // of waiting for the next runKey change or manual re-open.
  useEffect(() => {
    const wasActive = prevActiveRef.current
    prevActiveRef.current = isBookingActive
    if (wasActive && !isBookingActive && open) {
      // Small delay so the server has time to write finishRun to disk
      const id = setTimeout(() => fetchReplay(false), 600)
      return () => clearTimeout(id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBookingActive])

  // ── Relative-timestamp tick — every 1 s while open ─────────────────────────
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => setTick(t => t + 1), 1_000)
    return () => clearInterval(id)
  }, [open])

  if (!jobId) return null

  const outcome = replay ? OUTCOME_LABEL[replay.outcome] ?? OUTCOME_LABEL.unknown : null

  return (
    <div className="rounded-2xl overflow-hidden border border-divider bg-background">

      {/* ── Header toggle ────────────────────────────────────────────────── */}
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 active:opacity-60 transition-opacity"
      >
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-text-secondary">Last booking run</span>

          {/* Live-polling pulse — visible when a booking is in flight */}
          {isBookingActive && (
            <span className="flex items-center gap-1 text-[11px] text-accent-blue font-medium">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-blue opacity-60" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-accent-blue" />
              </span>
              Live
            </span>
          )}

          {/* Outcome badge — shown when idle and data exists */}
          {outcome && !isBookingActive && !loading && (
            <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded-md ${TONE_TEXT[outcome.tone]} ${TONE_BG[outcome.tone]}`}>
              {outcome.text}
            </span>
          )}

          {/* Spinner — only during initial load */}
          {loading && (
            <svg className="animate-spin h-3 w-3 text-text-muted" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Capture time — shown when collapsed and idle */}
          {!open && !isBookingActive && replay?.capturedAt && (
            <span className="text-[11px] text-text-muted tabular-nums">
              {absTime(replay.capturedAt)}
            </span>
          )}
          <span className="text-[11px] text-text-muted select-none">
            {open ? '↑' : '↓'}
          </span>
        </div>
      </button>

      {/* ── Timeline body ─────────────────────────────────────────────────── */}
      {open && (
        <div className="border-t border-divider">

          {/* In-progress placeholder — shown while booking is active and no events yet */}
          {isBookingActive && fetched && (!replay || replay.events.length === 0) && (
            <div className="px-4 py-4 flex items-center gap-2.5">
              <svg className="animate-spin h-3.5 w-3.5 text-accent-blue flex-shrink-0" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
              <span className="text-[13px] text-accent-blue">Booking in progress — capturing events…</span>
            </div>
          )}

          {/* Empty state — idle, no data */}
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
              {/* Vertical connector line */}
              <div
                className="absolute left-[27px] top-0 bottom-0 w-px bg-divider"
                aria-hidden="true"
              />

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
                    {/* Icon dot */}
                    <div className="relative z-10 flex-shrink-0 mt-0.5">
                      <span
                        className={`flex items-center justify-center w-7 h-7 rounded-full text-[13px]
                          ${isTerminal ? TONE_BG[tone] : 'bg-background'} border border-divider`}
                      >
                        {icon}
                      </span>
                    </div>

                    {/* Text */}
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

              {/* Trailing live indicator — shown after all events while still booking */}
              {isBookingActive && (
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

          {/* Footer — run metadata (only when idle and data exists) */}
          {!isBookingActive && replay && (
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-divider bg-surface/50">
              <span className="text-[11px] text-text-muted">
                {replay.events.length} event{replay.events.length !== 1 ? 's' : ''}
              </span>
              <span className="text-[11px] text-text-muted tabular-nums">
                {absTime(replay.capturedAt)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

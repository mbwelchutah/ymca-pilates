import { useState, useEffect, useCallback } from 'react'
import type { ReplaySummary, ReplayEventType } from '../lib/replayEvent'
import { REPLAY_ICON, REPLAY_TERMINAL_TYPES } from '../lib/replayEvent'
import { api } from '../lib/api'

// ── Helpers ──────────────────────────────────────────────────────────────────

function relTime(iso: string): string {
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

const TONE_DOT: Record<DotTone, string> = {
  green: 'bg-accent-green',
  amber: 'bg-accent-amber',
  red:   'bg-accent-red',
  blue:  'bg-accent-blue',
  gray:  'bg-text-muted/50',
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

// ── Props ─────────────────────────────────────────────────────────────────────

interface ReplayTimelineProps {
  jobId:   number | null
  runKey?: string | null   // changes when a new run finishes → triggers re-fetch
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ReplayTimeline({ jobId, runKey }: ReplayTimelineProps) {
  const [open,    setOpen]    = useState(false)
  const [replay,  setReplay]  = useState<ReplaySummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetched, setFetched] = useState(false)

  const fetchReplay = useCallback(async () => {
    if (!jobId) return
    setLoading(true)
    try {
      const data = await api.fetchReplay(jobId)
      setReplay(data)
    } finally {
      setLoading(false)
      setFetched(true)
    }
  }, [jobId])

  // Fetch when first opened, or whenever a new run key arrives (run finished)
  useEffect(() => {
    if (!open) return
    fetchReplay()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runKey, jobId])

  // When runKey changes while closed: clear stale data so the next open fetches fresh
  useEffect(() => {
    if (open) return
    setFetched(false)
    setReplay(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey, jobId])

  if (!jobId) return null

  const outcome   = replay ? OUTCOME_LABEL[replay.outcome] ?? OUTCOME_LABEL.unknown : null
  const lastEvent = replay?.events.at(-1)

  return (
    <div className="rounded-2xl overflow-hidden border border-divider bg-background">

      {/* ── Header toggle ────────────────────────────────────────────────── */}
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 active:opacity-60 transition-opacity"
      >
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-text-secondary">Last booking run</span>
          {/* Outcome badge — shown even when collapsed */}
          {outcome && !loading && (
            <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded-md ${TONE_TEXT[outcome.tone]} ${TONE_BG[outcome.tone]}`}>
              {outcome.text}
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
          {/* Capture time — when collapsed */}
          {!open && replay?.capturedAt && (
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

          {/* Empty / not-yet-fetched state */}
          {fetched && !replay && (
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
              {/* Vertical connector line — spans the inner dot column */}
              <div
                className="absolute left-[27px] top-0 bottom-0 w-px bg-divider"
                aria-hidden="true"
              />

              {replay.events.map((evt, idx) => {
                const tone      = eventTone(evt.type)
                const isTerminal = REPLAY_TERMINAL_TYPES.has(evt.type)
                const isLast    = idx === replay.events.length - 1
                const icon      = REPLAY_ICON[evt.type]

                return (
                  <div
                    key={idx}
                    className={[
                      'relative flex items-start gap-3 px-4 py-2.5',
                      isTerminal ? TONE_BG[tone] : '',
                      !isLast ? 'border-b border-divider/50' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    {/* Dot — sits on the vertical line */}
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
                          {relTime(evt.timestamp)}
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
            </div>
          )}

          {/* Footer — run metadata */}
          {replay && (
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

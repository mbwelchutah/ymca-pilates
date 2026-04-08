import { useState, useEffect } from 'react'

/**
 * Live countdown hook — ticks every second.
 * Canonical format shared by PlanScreen and NowScreen:
 *   • ≥1 day:  "3d 0h 8m"
 *   • ≥1 hour: "2h 15m 07s"  (seconds zero-padded)
 *   • <1 hour: "45m 07s"     (seconds zero-padded)
 * Returns '' when targetMs is null or the countdown has expired.
 */
export function useCountdown(targetMs: number | null): string {
  const [display, setDisplay] = useState('')
  useEffect(() => {
    if (!targetMs) { setDisplay(''); return }
    const tick = () => {
      const diff = targetMs - Date.now()
      if (diff <= 0) { setDisplay(''); return }
      const d  = Math.floor(diff / 86_400_000)
      const h  = Math.floor((diff % 86_400_000) / 3_600_000)
      const m  = Math.floor((diff % 3_600_000)  / 60_000)
      const s  = Math.floor((diff % 60_000)      / 1_000)
      const ss = String(s).padStart(2, '0')
      if (d > 0)      setDisplay(`${d}d ${h}h ${m}m`)
      else if (h > 0) setDisplay(`${h}h ${m}m ${ss}s`)
      else            setDisplay(`${m}m ${ss}s`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [targetMs])
  return display
}

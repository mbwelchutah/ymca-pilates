/**
 * Minimal Web Audio API sound cues — synthesised, no audio files needed.
 * Volume is kept very low (0.05–0.08) so tones are subtle, not intrusive.
 *
 * Platform note: On iOS Safari the AudioContext must be resumed inside a
 * user-gesture callback.  Tones triggered synchronously from a button tap
 * (arm, disarm) work fine.  Tones triggered after an async operation
 * (success/failure) may be blocked by autoplay policy — they fail silently.
 */

let _ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  try {
    if (!_ctx) {
      const AC =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!AC) return null
      _ctx = new AC()
    }
    // Resume if suspended (required after page load on some browsers)
    if (_ctx.state === 'suspended') _ctx.resume().catch(() => {})
    return _ctx
  } catch {
    return null
  }
}

function tone(
  ac:       AudioContext,
  freq:     number,
  start:    number,
  duration: number,
  volume:   number,
  type:     OscillatorType = 'sine',
): void {
  try {
    const osc  = ac.createOscillator()
    const gain = ac.createGain()
    osc.connect(gain)
    gain.connect(ac.destination)
    osc.type            = type
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0,      ac.currentTime + start)
    gain.gain.linearRampToValueAtTime(volume, ac.currentTime + start + 0.010)
    gain.gain.linearRampToValueAtTime(0,      ac.currentTime + start + duration)
    osc.start(ac.currentTime + start)
    osc.stop( ac.currentTime + start + duration + 0.005)
  } catch { /* AudioContext may be unavailable */ }
}

export type SoundCue = 'success' | 'error' | 'arm'

export function playTone(cue: SoundCue): void {
  const ac = getCtx()
  if (!ac) return
  switch (cue) {
    case 'success':
      // Soft ascending two-note chime (C5 → E5)
      tone(ac, 523, 0.00, 0.14, 0.07)
      tone(ac, 659, 0.08, 0.12, 0.06)
      break
    case 'error':
      // Single low muted thud
      tone(ac, 260, 0.00, 0.18, 0.06)
      break
    case 'arm':
      // Single short soft click
      tone(ac, 600, 0.00, 0.08, 0.05)
      break
  }
}

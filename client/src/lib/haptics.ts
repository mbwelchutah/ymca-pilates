/**
 * Haptic feedback utility — wraps navigator.vibrate() for Android support.
 * iOS Safari does not expose vibration; calls silently no-op on that platform.
 * All patterns are short and non-repeating per the iOS HIG spirit.
 */
export type HapticStyle = 'selection' | 'light' | 'medium' | 'success' | 'error'

export function haptic(style: HapticStyle): void {
  try {
    if (typeof navigator === 'undefined' || !navigator.vibrate) return
    switch (style) {
      case 'selection': navigator.vibrate(10);              break
      case 'light':     navigator.vibrate(20);              break
      case 'medium':    navigator.vibrate(40);              break
      case 'success':   navigator.vibrate([15, 60, 25]);    break
      case 'error':     navigator.vibrate([50, 40, 50]);    break
    }
  } catch {
    // Vibration API unavailable or blocked — safe to ignore
  }
}

import { useEffect } from 'react'

interface Props {
  src:     string | null
  onClose: () => void
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <path d="M1 1l16 16M17 1L1 17" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  )
}

export function ScreenshotLightbox({ src, onClose }: Props) {
  useEffect(() => {
    if (!src) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [src])

  useEffect(() => {
    if (!src) return
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [src, onClose])

  if (!src) return null

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/92 flex items-center justify-center"
      onClick={onClose}
    >
      <button
        onClick={e => { e.stopPropagation(); onClose() }}
        className="absolute top-4 right-4 p-2.5 rounded-full bg-white/10 text-white/80 hover:text-white hover:bg-white/20 active:bg-white/30 transition-colors"
        aria-label="Close screenshot"
      >
        <CloseIcon />
      </button>

      <img
        src={src}
        alt="Failure screenshot"
        className="max-w-[calc(100vw-32px)] max-h-[calc(100dvh-64px)] object-contain rounded-lg shadow-2xl"
        onClick={e => e.stopPropagation()}
      />
    </div>
  )
}

import { useEffect, useState } from 'react'

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
  const [imgError, setImgError] = useState(false)

  // Reset error state whenever a new screenshot is opened.
  useEffect(() => { setImgError(false) }, [src])

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

      {imgError ? (
        <div
          className="text-center px-8 py-10"
          onClick={e => e.stopPropagation()}
        >
          <p className="text-white/60 text-[15px]">Screenshot no longer available</p>
          <p className="text-white/35 text-[12px] mt-1">It may have been removed by the retention policy.</p>
        </div>
      ) : (
        <img
          src={src}
          alt="Failure screenshot"
          className="max-w-[calc(100vw-32px)] max-h-[calc(100dvh-64px)] object-contain rounded-lg shadow-2xl"
          onClick={e => e.stopPropagation()}
          onError={() => setImgError(true)}
        />
      )}
    </div>
  )
}

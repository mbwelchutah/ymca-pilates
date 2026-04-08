interface StatusDotProps {
  color: 'green' | 'amber' | 'red' | 'gray' | 'blue'
  pulse?: boolean
  size?: 'sm' | 'md'
}

const bgMap = {
  green: 'bg-accent-green',
  amber: 'bg-accent-amber',
  red:   'bg-accent-red',
  gray:  'bg-accent-gray',
  blue:  'bg-accent-blue',
}

const shadowMap = {
  green: 'shadow-[0_0_0_3px_rgba(52,199,89,0.2)]',
  amber: 'shadow-[0_0_0_3px_rgba(255,159,10,0.2)]',
  red:   'shadow-[0_0_0_3px_rgba(255,59,48,0.2)]',
  gray:  'shadow-[0_0_0_3px_rgba(174,174,178,0.2)]',
  blue:  'shadow-[0_0_0_3px_rgba(0,122,255,0.2)]',
}

const sizeMap = {
  sm: { dot: 'w-2 h-2',   ring: 'w-2 h-2' },
  md: { dot: 'w-2.5 h-2.5', ring: 'w-2.5 h-2.5' },
}

export function StatusDot({ color, pulse = false, size = 'md' }: StatusDotProps) {
  const sz = sizeMap[size]
  const bg = bgMap[color]

  if (pulse) {
    return (
      <span className={`relative inline-flex flex-shrink-0 ${sz.dot}`}>
        <span
          className={`absolute inline-flex rounded-full ${bg} animate-ping opacity-60`}
          style={{ inset: 0 }}
        />
        <span className={`relative inline-flex rounded-full ${bg} ${sz.dot}`} />
      </span>
    )
  }

  return (
    <span
      className={[
        'inline-block rounded-full flex-shrink-0',
        bg,
        shadowMap[color],
        sz.dot,
      ].join(' ')}
    />
  )
}

interface StatusDotProps {
  color: 'green' | 'amber' | 'red' | 'gray' | 'blue'
  pulse?: boolean
  size?: 'sm' | 'md'
}

const colorMap = {
  green: 'bg-accent-green shadow-[0_0_0_3px_rgba(52,199,89,0.2)]',
  amber: 'bg-accent-amber shadow-[0_0_0_3px_rgba(255,159,10,0.2)]',
  red:   'bg-accent-red shadow-[0_0_0_3px_rgba(255,59,48,0.2)]',
  gray:  'bg-accent-gray shadow-[0_0_0_3px_rgba(174,174,178,0.2)]',
  blue:  'bg-accent-blue shadow-[0_0_0_3px_rgba(0,122,255,0.2)]',
}

const sizeMap = {
  sm: 'w-2 h-2',
  md: 'w-2.5 h-2.5',
}

export function StatusDot({ color, size = 'md' }: StatusDotProps) {
  return (
    <span className={`inline-block rounded-full flex-shrink-0 ${colorMap[color]} ${sizeMap[size]}`} />
  )
}

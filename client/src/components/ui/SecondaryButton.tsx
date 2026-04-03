import { ReactNode, ButtonHTMLAttributes } from 'react'

interface SecondaryButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
  variant?: 'default' | 'subtle'
  fullWidth?: boolean
}

const variantMap = {
  default: 'bg-divider text-text-primary',
  subtle:  'bg-divider text-text-secondary',
}

export function SecondaryButton({ children, variant = 'default', fullWidth = false, className = '', ...props }: SecondaryButtonProps) {
  return (
    <button
      {...props}
      className={`
        ${variantMap[variant]} font-semibold text-[15px] tracking-tight
        rounded-btn px-5 py-4 active:opacity-70 transition-opacity
        disabled:opacity-40
        ${fullWidth ? 'w-full' : ''}
        ${className}
      `}
    >
      {children}
    </button>
  )
}

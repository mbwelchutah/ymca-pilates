import { ReactNode, ButtonHTMLAttributes } from 'react'

interface SecondaryButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
  variant?: 'default' | 'subtle' | 'tinted'
  fullWidth?: boolean
}

const variantMap = {
  // Neutral iOS "grey filled" — safe default for Cancel/back actions
  default: 'bg-divider text-text-primary',
  subtle:  'bg-divider text-text-secondary',
  // iOS "tinted" — translucent blue wash with blue label; opt-in for accent actions
  tinted:  'bg-[rgba(0,122,255,0.12)] text-accent-blue',
}

export function SecondaryButton({ children, variant = 'default', fullWidth = false, className = '', ...props }: SecondaryButtonProps) {
  return (
    <button
      {...props}
      className={`
        ${variantMap[variant]} font-semibold text-[17px] tracking-[-0.01em]
        rounded-btn px-5 py-3.5
        active:opacity-85 active:scale-[0.985]
        transition-[transform,opacity] duration-150 ease-out
        disabled:opacity-40 disabled:active:scale-100
        ${fullWidth ? 'w-full' : ''}
        ${className}
      `}
    >
      {children}
    </button>
  )
}

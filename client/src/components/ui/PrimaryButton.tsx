import { ReactNode, ButtonHTMLAttributes } from 'react'

interface PrimaryButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
  fullWidth?: boolean
}

export function PrimaryButton({ children, fullWidth = false, className = '', ...props }: PrimaryButtonProps) {
  return (
    <button
      {...props}
      className={`
        bg-accent-blue text-white font-semibold text-[15px] tracking-tight
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

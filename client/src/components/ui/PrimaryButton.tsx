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
        bg-accent-blue text-white font-semibold text-[17px] tracking-[-0.01em]
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

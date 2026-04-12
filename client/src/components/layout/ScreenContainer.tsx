import { ReactNode } from 'react'

interface ScreenContainerProps {
  children: ReactNode
  className?: string
}

export function ScreenContainer({ children, className = '' }: ScreenContainerProps) {
  return (
    <div className={`min-h-full pb-tab px-5 pt-4 flex flex-col gap-3 ${className}`}>
      {children}
    </div>
  )
}

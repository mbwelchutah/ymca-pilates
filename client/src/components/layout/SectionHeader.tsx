interface SectionHeaderProps {
  title: string
  action?: {
    label: string
    onClick: () => void
  }
}

export function SectionHeader({ title, action }: SectionHeaderProps) {
  return (
    <div className="flex items-center justify-between px-1 mb-1">
      <h2 className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide">
        {title}
      </h2>
      {action && (
        <button
          onClick={action.onClick}
          className="text-[13px] font-semibold text-accent-blue active:opacity-70"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}

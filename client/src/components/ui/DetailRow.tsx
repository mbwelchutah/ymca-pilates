interface DetailRowProps {
  label: string
  value: string
  last?: boolean
}

export function DetailRow({ label, value, last = false }: DetailRowProps) {
  return (
    <>
      <div className="flex items-center justify-between py-3 px-4">
        <span className="text-[14px] text-text-secondary">{label}</span>
        <span className="text-[14px] text-text-primary font-medium text-right max-w-[58%]">{value}</span>
      </div>
      {!last && <div className="h-px bg-divider mx-4" />}
    </>
  )
}

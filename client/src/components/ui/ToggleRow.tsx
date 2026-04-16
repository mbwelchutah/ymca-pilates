export function ToggleRow({ label, detail, value, onChange }: {
  label: string
  detail?: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3.5">
      <div className="flex-1 mr-4">
        <p className="text-[15px] text-text-primary font-medium">{label}</p>
        {detail && <p className="text-[12px] text-text-secondary mt-0.5">{detail}</p>}
      </div>
      <button
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`
          relative inline-flex items-center h-[31px] w-[51px] rounded-pill flex-shrink-0
          transition-colors duration-200 ease-out
          ${value ? 'bg-accent-green' : 'bg-[#e9e9ea]'}
        `}
      >
        <span
          className={`
            absolute h-[27px] w-[27px] bg-white rounded-full
            shadow-[0_3px_8px_rgba(0,0,0,0.15),0_1px_1px_rgba(0,0,0,0.08)]
            transition-transform duration-200 ease-out
            ${value ? 'translate-x-[22px]' : 'translate-x-[2px]'}
          `}
        />
      </button>
    </div>
  )
}

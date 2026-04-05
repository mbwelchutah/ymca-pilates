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
          relative inline-flex items-center h-7 w-12 rounded-pill transition-colors flex-shrink-0
          ${value ? 'bg-accent-green' : 'bg-[#e5e5ea]'}
        `}
      >
        <span
          className={`
            absolute h-6 w-6 bg-white rounded-full shadow-sm
            transition-transform duration-200
            ${value ? 'translate-x-[calc(100%-4px)]' : 'translate-x-[2px]'}
          `}
        />
      </button>
    </div>
  )
}

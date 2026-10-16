import { currentMonth, monthLabel, shiftMonth } from "./format";
import { Icon } from "./ui";

export default function MonthPicker({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  const isCurrent = month === currentMonth();
  return (
    <div className="month-picker" role="group" aria-label="Pilih bulan">
      <button type="button" className="icon-btn" onClick={() => onChange(shiftMonth(month, -1))} aria-label="Bulan sebelumnya">
        <Icon name="chevronLeft" size={18} />
      </button>
      <span className="month-label">{monthLabel(month)}</span>
      <button type="button" className="icon-btn" onClick={() => onChange(shiftMonth(month, 1))} aria-label="Bulan berikutnya">
        <Icon name="chevronRight" size={18} />
      </button>
      {!isCurrent && (
        <button type="button" className="text-btn" onClick={() => onChange(currentMonth())}>Bulan ini</button>
      )}
    </div>
  );
}

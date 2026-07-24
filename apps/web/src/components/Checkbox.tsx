import { Check } from 'lucide-react';

/**
 * Custom checkbox: a visually hidden native input keeps keyboard and screen-
 * reader behavior intact (Space toggles, focus ring via peer), while the
 * styled box renders the site's language — token border, --link-blue fill,
 * and a check that scales in.
 */
export default function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: React.ReactNode;
}) {
  return (
    <label className="group flex cursor-pointer items-center gap-2.5 py-1 text-sm text-(--sea-ink) sm:py-0">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={`flex size-4.5 shrink-0 items-center justify-center rounded-md border transition duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-(--link-blue)/70 ${
          checked
            ? 'border-(--link-blue) bg-(--link-blue)'
            : 'border-(--sea-ink)/25 bg-transparent group-hover:border-(--sea-ink)/50'
        }`}
      >
        <Check
          strokeWidth={3.5}
          className={`size-3 text-white transition duration-150 ${
            checked ? 'scale-100 opacity-100' : 'scale-50 opacity-0'
          }`}
        />
      </span>
      <span className="min-w-0">{label}</span>
    </label>
  );
}

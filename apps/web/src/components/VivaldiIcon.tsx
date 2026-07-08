/**
 * Vivaldi brand logo — the white "V" swoosh on the red rounded square.
 * `aria-hidden`; sized via `className`.
 */
export default function VivaldiIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1900 1900"
      aria-hidden="true"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fill="#ef3939"
        d="M944 1830c386 0 600 0 740-140s140-354 140-740 0-600-140-740S1330 70 944 70s-600 0-740 140S64 564 64 950s0 600 140 740 354 140 740 140z"
      />
      <path
        fill="#fff"
        d="M1407 484a657.9 657.9 0 00-932 0 660.9 660.9 0 000 933 657.9 657.9 0 00932 0 660.9 660.9 0 000-933zm-39 304l-326 567c-20 35-49 56-90 59-45 3-80-16-103-55L519 786c-42-73 5-162 89-166 44-2 78 18 101 57 31 52 61 105 91 158l66 114c33 55 80 85 144 89 90 5 174-60 185-156 1-7 1-14 2-18 0-31-6-57-19-82-34-68 2-143 75-160 60-13 121 31 129 91 4 27-1 52-14 75z"
      />
    </svg>
  );
}

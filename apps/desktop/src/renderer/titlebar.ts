// The brand mark (apps/web/public/favicon.svg); navy frame in light, swapped to white in dark.
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 130 130"><path d="M75,10 H20 A10,10 0 0 0 10,20 V100 A10,10 0 0 0 20,110 H85" fill="none" stroke="#001C55" stroke-width="6" stroke-linecap="round"/><path d="M100,35 V20 A10,10 0 0 0 90,10 H85" fill="none" stroke="#001C55" stroke-width="6" stroke-linecap="round"/><rect x="95" y="100" width="14" height="30" rx="6" ry="6" fill="#001C55" transform="rotate(-45 95 100)"/><rect x="98" y="80" width="7" height="30" rx="6" ry="6" fill="#001C55" transform="rotate(-45 95 100)"/><circle cx="60" cy="60" r="38" fill="#001C55"/><clipPath id="cc"><circle cx="60" cy="60" r="29"/></clipPath><g clip-path="url(#cc)"><rect x="18" y="18" width="84" height="84" fill="#012169"/><path d="M18,18 L102,102 M102,18 L18,102" stroke="white" stroke-width="12"/><path d="M18,18 L102,102 M102,18 L18,102" stroke="#C8102E" stroke-width="4"/><path d="M60,18 V102 M18,60 H102" stroke="white" stroke-width="20"/><path d="M60,18 V102 M18,60 H102" stroke="#C8102E" stroke-width="12"/></g></svg>`;
const ICON_LIGHT = `data:image/svg+xml;utf8,${encodeURIComponent(ICON_SVG)}`;
const ICON_DARK = `data:image/svg+xml;utf8,${encodeURIComponent(ICON_SVG.replace(/#001C55/g, '#ffffff'))}`;

const back = document.getElementById('tb-back') as HTMLButtonElement;
const fwd = document.getElementById('tb-fwd') as HTMLButtonElement;
const titleEl = document.getElementById('tb-title') as HTMLSpanElement;
const iconEl = document.getElementById('tb-icon') as HTMLImageElement;
iconEl.src = ICON_DARK; // matches the default `.dark`; corrected on first theme event

back.addEventListener('click', () => window.titlebar.back());
fwd.addEventListener('click', () => window.titlebar.forward());

window.titlebar.onNavState((s) => {
  back.disabled = !s.canGoBack;
  fwd.disabled = !s.canGoForward;
});
window.titlebar.onTitle((t) => {
  titleEl.textContent = t?.trim() || 'SponsorSearch';
});
window.titlebar.onTheme((t) => {
  document.documentElement.classList.toggle('dark', t.dark);
  iconEl.src = t.dark ? ICON_DARK : ICON_LIGHT;
});

window.titlebar.ready();

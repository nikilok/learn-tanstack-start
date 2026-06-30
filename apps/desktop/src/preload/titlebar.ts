import { ipcRenderer } from 'electron';

// The brand mark (apps/web/public/favicon.svg), inlined so the title-bar view needs no asset server.
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 130 130"><path d="M75,10 H20 A10,10 0 0 0 10,20 V100 A10,10 0 0 0 20,110 H85" fill="none" stroke="#001C55" stroke-width="6" stroke-linecap="round"/><path d="M100,35 V20 A10,10 0 0 0 90,10 H85" fill="none" stroke="#001C55" stroke-width="6" stroke-linecap="round"/><rect x="95" y="100" width="14" height="30" rx="6" ry="6" fill="#001C55" transform="rotate(-45 95 100)"/><rect x="98" y="80" width="7" height="30" rx="6" ry="6" fill="#001C55" transform="rotate(-45 95 100)"/><circle cx="60" cy="60" r="38" fill="#001C55"/><clipPath id="cc"><circle cx="60" cy="60" r="29"/></clipPath><g clip-path="url(#cc)"><rect x="18" y="18" width="84" height="84" fill="#012169"/><path d="M18,18 L102,102 M102,18 L18,102" stroke="white" stroke-width="12"/><path d="M18,18 L102,102 M102,18 L18,102" stroke="#C8102E" stroke-width="4"/><path d="M60,18 V102 M18,60 H102" stroke="white" stroke-width="20"/><path d="M60,18 V102 M18,60 H102" stroke="#C8102E" stroke-width="12"/></g></svg>`;

// Light theme uses the navy frame; dark swaps navy -> white so the mark stays visible.
const ICON_LIGHT = `data:image/svg+xml;utf8,${encodeURIComponent(ICON_SVG)}`;
const ICON_DARK = `data:image/svg+xml;utf8,${encodeURIComponent(ICON_SVG.replace(/#001C55/g, '#ffffff'))}`;

const BACK_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>`;
const FWD_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>`;

const STYLE = `
  /* Pill matches the web app's LastUpdated component (--bg-base/80, --line, --sea-ink-faint). */
  :root {
    --tb-fg:#e7e9ee; --tb-btn:rgba(255,255,255,.10); --tb-faint:#7a7a7a;
    --tb-box-bg:rgba(10,10,10,.8); --tb-box-bd:#2a2a2a;
  }
  html[data-tb-light] {
    --tb-fg:#1f2430; --tb-btn:rgba(0,0,0,.07);
    --tb-box-bg:rgba(255,255,255,.8); --tb-box-bd:#ebebeb;
  }
  * { box-sizing:border-box; }
  body {
    margin:0; height:100vh; position:relative;
    color:var(--tb-fg); background:transparent;
    font:600 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    -webkit-app-region:drag; -webkit-user-select:none; user-select:none; overflow:hidden;
  }
  /* Pinned left, in its own pill with a divider — never moves when the title resizes. */
  .nav {
    position:absolute; left:100px; top:50%; transform:translateY(-50%);
    display:flex; align-items:center; height:32px; padding:0 5px;
    border-radius:9999px; background:var(--tb-box-bg); border:1px solid var(--tb-box-bd);
    backdrop-filter:blur(4px); -webkit-backdrop-filter:blur(4px); -webkit-app-region:no-drag;
  }
  .nav button {
    width:30px; height:24px; border:0; padding:0; background:transparent; color:var(--tb-fg);
    cursor:pointer; display:grid; place-items:center; opacity:.55;
    transition:opacity .12s;
  }
  .nav button:hover:not(:disabled){ opacity:1; }
  .nav button:disabled{ opacity:.25; cursor:default; }
  .nav .div { width:1px; height:16px; margin:0 3px; background:var(--tb-box-bd); flex:none; }
  /* Fixed-width pill; the title stays dead-centered inside it. */
  .titlebox {
    position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
    width:min(460px, calc(100vw - 400px)); height:32px;
    display:flex; align-items:center; justify-content:center; gap:8px;
    padding:0 16px; border-radius:9999px;
    background:var(--tb-box-bg); border:1px solid var(--tb-box-bd);
    backdrop-filter:blur(4px); -webkit-backdrop-filter:blur(4px);
  }
  .titlebox img { width:16px; height:16px; display:block; flex:none; }
  .titlebox span {
    font-weight:400; font-size:13px; color:var(--tb-faint);
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;
  }
`;

/** Builds the title-bar UI and wires back/forward + theme to the main process. */
function build(): void {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  document.body.innerHTML =
    `<div class="nav">` +
    `<button id="tb-back" aria-label="Back" title="Back">${BACK_ICON}</button>` +
    `<span class="div"></span>` +
    `<button id="tb-fwd" aria-label="Forward" title="Forward">${FWD_ICON}</button>` +
    `</div>` +
    `<div class="titlebox"><img id="tb-icon" src="${ICON_LIGHT}" alt=""><span id="tb-title">SponsorSearch</span></div>`;

  const back = document.getElementById('tb-back') as HTMLButtonElement;
  const fwd = document.getElementById('tb-fwd') as HTMLButtonElement;
  const titleEl = document.getElementById('tb-title') as HTMLSpanElement;
  const iconEl = document.getElementById('tb-icon') as HTMLImageElement;
  back.addEventListener('click', () =>
    ipcRenderer.send('titlebar:nav', 'back'),
  );
  fwd.addEventListener('click', () =>
    ipcRenderer.send('titlebar:nav', 'forward'),
  );

  ipcRenderer.on(
    'titlebar:navstate',
    (_e, s: { canGoBack: boolean; canGoForward: boolean }) => {
      back.disabled = !s.canGoBack;
      fwd.disabled = !s.canGoForward;
    },
  );
  ipcRenderer.on('titlebar:theme', (_e, t: { dark: boolean }) => {
    document.documentElement.toggleAttribute('data-tb-light', !t.dark);
    iconEl.src = t.dark ? ICON_DARK : ICON_LIGHT;
  });
  ipcRenderer.on('titlebar:title', (_e, title: string) => {
    titleEl.textContent = title?.trim() || 'SponsorSearch';
  });

  ipcRenderer.send('titlebar:ready');
}

window.addEventListener('DOMContentLoaded', build);

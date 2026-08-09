import { createRoot } from 'react-dom/client';

import { BlockedScreen } from './components/BlockedScreen';
import { SplashScreen } from './components/SplashScreen';
import { TitleBar } from './components/TitleBar';
import { TooltipOverlay } from './components/TooltipOverlay';

// One bundle, four views: the title bar, the keycap tooltip, the launch splash, and the
// stand-in screen shown when the site cannot be reached (?role=tooltip|splash|blocked).
const params = new URLSearchParams(window.location.search);
const role = params.get('role');
const root = document.getElementById('root');

// The splash paints before the page exists to report a theme, so main passes the one it
// remembered from last launch on the URL. Stamped here, before the first render, rather
// than in an effect — an effect would paint the wrong ground for a frame first.
if (role === 'splash') {
  document.documentElement.classList.toggle(
    'dark',
    params.get('theme') !== 'light',
  );
}
const VIEWS = {
  tooltip: TooltipOverlay,
  splash: SplashScreen,
  blocked: BlockedScreen,
} as const;
if (root) {
  const View = VIEWS[role as keyof typeof VIEWS] ?? TitleBar;
  createRoot(root).render(<View />);
}

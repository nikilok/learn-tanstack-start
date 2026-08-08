import { createRoot } from 'react-dom/client';

import { BlockedScreen } from './components/BlockedScreen';
import { SplashScreen } from './components/SplashScreen';
import { TitleBar } from './components/TitleBar';
import { TooltipOverlay } from './components/TooltipOverlay';

// One bundle, four views: the title bar, the keycap tooltip, the launch splash, and the
// stand-in screen shown when the site cannot be reached (?role=tooltip|splash|blocked).
const role = new URLSearchParams(window.location.search).get('role');
const root = document.getElementById('root');
const VIEWS = {
  tooltip: TooltipOverlay,
  splash: SplashScreen,
  blocked: BlockedScreen,
} as const;
if (root) {
  const View = VIEWS[role as keyof typeof VIEWS] ?? TitleBar;
  createRoot(root).render(<View />);
}

import { createRoot } from 'react-dom/client';

import { BlockedScreen } from './components/BlockedScreen';
import { TitleBar } from './components/TitleBar';
import { TooltipOverlay } from './components/TooltipOverlay';

// One bundle, three views: the title bar, the keycap tooltip, and the stand-in screen
// shown when the site cannot be reached (?role=tooltip / ?role=blocked).
const role = new URLSearchParams(window.location.search).get('role');
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    role === 'tooltip' ? (
      <TooltipOverlay />
    ) : role === 'blocked' ? (
      <BlockedScreen />
    ) : (
      <TitleBar />
    ),
  );
}

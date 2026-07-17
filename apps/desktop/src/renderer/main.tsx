import { createRoot } from 'react-dom/client';

import { TitleBar } from './components/TitleBar';
import { TooltipOverlay } from './components/TooltipOverlay';

// The same bundle serves two views: the title bar, and a bare tooltip overlay (?role=tooltip).
const isTooltip =
  new URLSearchParams(window.location.search).get('role') === 'tooltip';
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(isTooltip ? <TooltipOverlay /> : <TitleBar />);
}

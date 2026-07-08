import { useBrowser } from '../hooks/useBrowser';
import BraveIcon from './BraveIcon';
import ChromeIcon from './ChromeIcon';
import ChromiumIcon from './ChromiumIcon';
import EdgeIcon from './EdgeIcon';
import OperaIcon from './OperaIcon';
import VivaldiIcon from './VivaldiIcon';

/**
 * Full-colour logo of the visitor's current browser — the install surfaces read
 * "install in *this* browser" (Edge shows the Edge mark, Brave the Brave mark,
 * …). Chrome-engine forks that keep the `Chrome/` token show the Chrome mark;
 * genuinely unrecognised UAs fall back to the neutral Chromium mark. Sized via
 * `className`; `aria-hidden` (the parent control names it).
 */
export default function BrowserIcon({ className }: { className?: string }) {
  const browser = useBrowser();
  switch (browser) {
    case 'edge':
      return <EdgeIcon className={className} />;
    case 'brave':
      return <BraveIcon className={className} />;
    case 'opera':
      return <OperaIcon className={className} />;
    case 'vivaldi':
      return <VivaldiIcon className={className} />;
    case 'chrome':
      return <ChromeIcon className={className} />;
    default:
      return <ChromiumIcon className={className} />;
  }
}

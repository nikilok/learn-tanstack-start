import type { DesktopPlatform } from '../api/releases';

/**
 * Desktop preview screenshots per platform + theme, referenced entirely
 * client-side (no server call) so the light/dark swap is a pure CSS `.dark`
 * toggle with no hydration flash. These are placeholders — drop real captures
 * into /public/download/ under the same names to replace them.
 */
const DESKTOP_SHOTS: Record<DesktopPlatform, { light: string; dark: string }> =
  {
    mac: {
      light: '/download/desktop-mac-light.png',
      dark: '/download/desktop-mac-dark.png',
    },
    win: {
      light: '/download/desktop-win-light.png',
      dark: '/download/desktop-win-dark.png',
    },
    linux: {
      light: '/download/desktop-linux-light.png',
      dark: '/download/desktop-linux-dark.png',
    },
  };

/** Platform screenshot that swaps with the theme — both variants ship, CSS shows one. */
export default function DesktopPreview({
  platform,
}: {
  platform: DesktopPlatform;
}) {
  const shots = DESKTOP_SHOTS[platform];
  return (
    <>
      <img
        src={shots.light}
        alt=""
        className="block h-full w-full object-cover dark:hidden"
      />
      <img
        src={shots.dark}
        alt=""
        className="hidden h-full w-full object-cover dark:block"
      />
    </>
  );
}

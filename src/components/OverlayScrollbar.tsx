import { OverlayScrollbars } from 'overlayscrollbars';
import { useEffect } from 'react';
import 'overlayscrollbars/overlayscrollbars.css';

const isMobile = () =>
  typeof window !== 'undefined' &&
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

function getTheme() {
  return document.documentElement.dataset.theme === 'dark'
    ? 'os-theme-light'
    : 'os-theme-dark';
}

export default function OverlayScrollbar() {
  useEffect(() => {
    if (isMobile()) return;

    const instance = OverlayScrollbars(document.body, {
      scrollbars: {
        theme: getTheme(),
        autoHide: 'scroll',
        autoHideDelay: 800,
      },
    });

    // The padding wrapper gets overflow:hidden which breaks sticky positioning.
    // Move sticky elements to fixed positioning instead.
    const viewport = instance.elements().viewport;
    const header = document.querySelector('.site-header');
    if (header instanceof HTMLElement && viewport) {
      header.style.position = 'fixed';
      header.style.top = '0';
      header.style.left = '0';
      header.style.right = '0';
      // Add padding to body content to compensate for header leaving the flow
      const headerHeight = header.offsetHeight;
      viewport.style.paddingTop = `${headerHeight}px`;
    }

    const observer = new MutationObserver(() => {
      instance.options({ scrollbars: { theme: getTheme() } });
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      observer.disconnect();
      instance.destroy();
    };
  }, []);

  return null;
}

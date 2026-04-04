import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export default function Tooltip({
  text,
  children,
}: {
  text: string;
  children: React.ReactNode;
}) {
  const [visible, setVisible] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const updatePos = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    let left = rect.left;

    if (tooltipRef.current) {
      const tipRect = tooltipRef.current.getBoundingClientRect();
      const overflow = left + tipRect.width - window.innerWidth + 8;
      if (overflow > 0) left -= overflow;
    }

    setPos({ top: rect.bottom + 4, left: Math.max(8, left) });
  }, []);

  useEffect(() => {
    if (!visible) return;
    // Position once on open, then again after tooltip renders to measure actual width
    updatePos();
    requestAnimationFrame(updatePos);
  }, [visible, updatePos]);

  useEffect(() => {
    if (!visible) return;
    const dismiss = () => setVisible(false);
    const handleClick = (e: MouseEvent) => {
      if (!triggerRef.current?.contains(e.target as Node)) dismiss();
    };
    document.addEventListener('click', handleClick);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('click', handleClick);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [visible]);

  return (
    <button
      ref={triggerRef}
      type="button"
      className="w-full text-left"
      onClick={() => setVisible((v) => !v)}
    >
      {children}
      {visible &&
        createPortal(
          <div
            ref={tooltipRef}
            className="glass fixed z-9999 max-w-xs rounded-lg px-3 py-2 text-sm text-(--sea-ink) shadow-lg"
            style={{
              top: pos.top,
              left: pos.left,
              backdropFilter: 'blur(8px)',
            }}
          >
            {text}
          </div>,
          document.body,
        )}
    </button>
  );
}

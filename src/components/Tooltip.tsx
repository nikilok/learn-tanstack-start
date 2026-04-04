import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export default function Tooltip({
  text,
  children,
}: {
  text: string;
  children: React.ReactNode;
}) {
  const [visible, setVisible] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!visible || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.left });
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const dismiss = () => setVisible(false);
    const handleClick = (e: MouseEvent) => {
      if (!triggerRef.current?.contains(e.target as Node)) dismiss();
    };
    document.addEventListener("click", handleClick);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("click", handleClick);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [visible]);

  return (
    <div ref={triggerRef} onClick={() => setVisible((v) => !v)}>
      {children}
      {visible &&
        createPortal(
          <div
            className="glass fixed z-9999 max-w-xs rounded-lg px-3 py-2 text-sm text-(--sea-ink) shadow-lg"
            style={{
              top: pos.top,
              left: pos.left,
              backdropFilter: "blur(8px)",
            }}
          >
            {text}
          </div>,
          document.body,
        )}
    </div>
  );
}

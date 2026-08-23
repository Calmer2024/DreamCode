import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

interface TooltipState {
  content: string;
  left: number;
  top: number;
  side: "left" | "right";
}

export function TooltipLayer() {
  const [tooltip, setTooltip] = useState<TooltipState>();

  useEffect(() => {
    const show = (target: EventTarget | null) => {
      const anchor =
        target instanceof Element ? target.closest<HTMLElement>("[data-tooltip]") : null;
      const content = anchor?.dataset.tooltip?.trim();
      if (!anchor || !content) return;
      const rect = anchor.getBoundingClientRect();
      const side = rect.right + 280 <= window.innerWidth ? "right" : "left";
      setTooltip({
        content,
        left: side === "right" ? rect.right + 10 : rect.left - 10,
        top: rect.top + rect.height / 2,
        side,
      });
    };
    const hide = () => setTooltip(undefined);
    const handlePointerOver = (event: PointerEvent) => show(event.target);
    const handlePointerOut = (event: PointerEvent) => {
      const anchor =
        event.target instanceof Element ? event.target.closest("[data-tooltip]") : null;
      if (anchor && event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget))
        return;
      hide();
    };
    const handleFocusIn = (event: FocusEvent) => show(event.target);
    const handleFocusOut = () => hide();

    document.addEventListener("pointerover", handlePointerOver);
    document.addEventListener("pointerout", handlePointerOut);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("pointerover", handlePointerOver);
      document.removeEventListener("pointerout", handlePointerOut);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, []);

  if (!tooltip) return null;
  return createPortal(
    <div
      className="app-tooltip"
      data-side={tooltip.side}
      role="tooltip"
      style={{ left: tooltip.left, top: tooltip.top }}
    >
      {tooltip.content}
    </div>,
    document.body,
  );
}

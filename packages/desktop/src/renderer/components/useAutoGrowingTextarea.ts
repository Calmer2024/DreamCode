import { useLayoutEffect, useRef } from "react";

export function useAutoGrowingTextarea(maxHeight = 240) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;

    textarea.style.height = "0px";
    const styles = window.getComputedStyle(textarea);
    const borderHeight =
      (Number.parseFloat(styles.borderTopWidth) || 0) +
      (Number.parseFloat(styles.borderBottomWidth) || 0);
    const contentHeight = textarea.scrollHeight + borderHeight;
    textarea.style.height = `${Math.min(contentHeight, maxHeight)}px`;
    textarea.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  });

  return ref;
}

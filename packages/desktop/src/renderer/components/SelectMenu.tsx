import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface SelectMenuOption {
  value: string;
  label: string;
  icon?: ReactNode;
  description?: string;
}

interface SelectMenuProps {
  label: string;
  value: string;
  options: SelectMenuOption[];
  disabled?: boolean;
  accent?: "plan" | "guided" | "yolo" | "full";
  icon?: ReactNode;
  className?: string;
  onChange: (value: string) => void;
}

const viewportGap = 8;

export function SelectMenu({
  label,
  value,
  options,
  disabled,
  accent,
  icon,
  className = "",
  onChange,
}: SelectMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    direction: "down" | "up";
    left: number;
    top?: number;
    bottom?: number;
    width: number;
    maxHeight: number;
  }>();
  const selected = options.find((option) => option.value === value);

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const direction = rect.top + rect.height / 2 < window.innerHeight / 2 ? "down" : "up";
    const available = direction === "down" ? window.innerHeight - rect.bottom - 14 : rect.top - 14;
    const width = Math.max(rect.width, 190);
    const left = Math.min(
      Math.max(viewportGap, rect.left),
      window.innerWidth - width - viewportGap,
    );
    setPosition({
      direction,
      left,
      top: direction === "down" ? rect.bottom + 6 : undefined,
      bottom: direction === "up" ? window.innerHeight - rect.top + 6 : undefined,
      width,
      maxHeight: Math.max(96, available),
    });
  }, []);

  useLayoutEffect(() => {
    if (open) measure();
  }, [measure, open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target))
        setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", keydown);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [measure, open]);

  return (
    <div className={`select-menu-control ${className}`} data-accent={accent}>
      <select
        className="native-select-proxy"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <button
        ref={triggerRef}
        type="button"
        className="select-menu-trigger"
        aria-label={`${label}选项`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        {icon}
        {selected?.icon}
        <span>{selected?.label ?? value}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              className="select-menu-popover"
              role="listbox"
              aria-label={label}
              data-direction={position.direction}
              style={{
                left: position.left,
                top: position.top,
                bottom: position.bottom,
                width: position.width,
                maxHeight: position.maxHeight,
              }}
            >
              {options.map((option) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  key={option.value}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  {option.icon}
                  <span className="select-menu-option-copy">
                    <span>{option.label}</span>
                    {option.description ? <small>{option.description}</small> : null}
                  </span>
                  {option.value === value ? <Check aria-hidden="true" /> : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

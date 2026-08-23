import { Archive, Folder, GitBranch, MoreHorizontal, Pencil, Pin, PinOff, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface ProjectMoreMenuProps {
  projectName: string;
  pinned: boolean;
  triggerClassName?: string;
  triggerLabel?: string;
  onTogglePin: () => void;
  onOpenWorkspace: () => void;
  onRename: () => void;
  onRemove: () => void;
}

type MenuPosition = {
  direction: "down" | "up";
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
};

const menuWidth = 218;
const viewportGap = 8;
const triggerGap = 6;
const closeDuration = 140;

export function ProjectMoreMenu({
  projectName,
  pinned,
  triggerClassName = "project-more-button",
  triggerLabel = "项目更多操作",
  onTogglePin,
  onOpenWorkspace,
  onRename,
  onRemove,
}: ProjectMoreMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const openFrameRef = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [renderMenu, setRenderMenu] = useState(false);
  const [position, setPosition] = useState<MenuPosition>();

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const direction = rect.top + rect.height / 2 <= window.innerHeight / 2 ? "down" : "up";
    const available =
      direction === "down"
        ? window.innerHeight - rect.bottom - triggerGap - viewportGap
        : rect.top - triggerGap - viewportGap;
    const left = Math.min(
      Math.max(viewportGap, rect.left),
      Math.max(viewportGap, window.innerWidth - menuWidth - viewportGap),
    );
    setPosition({
      direction,
      left,
      top: direction === "down" ? rect.bottom + triggerGap : undefined,
      bottom: direction === "up" ? window.innerHeight - rect.top + triggerGap : undefined,
      maxHeight: Math.max(80, available),
    });
  }, []);

  const close = useCallback((restoreFocus = false) => {
    window.cancelAnimationFrame(openFrameRef.current ?? 0);
    setOpen(false);
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => setRenderMenu(false), closeDuration);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const show = () => {
    window.clearTimeout(closeTimerRef.current);
    setRenderMenu(true);
    openFrameRef.current = window.requestAnimationFrame(() => setOpen(true));
  };

  useLayoutEffect(() => {
    if (renderMenu) measure();
  }, [measure, renderMenu]);

  useEffect(() => {
    if (!renderMenu) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [close, measure, renderMenu]);

  useEffect(
    () => () => {
      window.clearTimeout(closeTimerRef.current);
      window.cancelAnimationFrame(openFrameRef.current ?? 0);
    },
    [],
  );

  const act = (action: () => void) => {
    action();
    close();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-label={triggerLabel}
        data-tooltip={`${projectName} 更多操作`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : show())}
      >
        <MoreHorizontal aria-hidden="true" />
      </button>
      {renderMenu && position
        ? createPortal(
            <div
              ref={menuRef}
              className="project-menu"
              role="menu"
              aria-label={`${projectName} 项目操作`}
              data-direction={position.direction}
              data-state={open ? "open" : "closed"}
              style={{
                left: position.left,
                top: position.top,
                bottom: position.bottom,
                width: menuWidth,
                maxHeight: position.maxHeight,
              }}
            >
              <MenuItem
                icon={pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
                label={pinned ? "取消置顶" : "置顶项目"}
                onClick={() => act(onTogglePin)}
              />
              <MenuItem
                icon={<Folder aria-hidden="true" />}
                label="在资源管理器中打开"
                onClick={() => act(onOpenWorkspace)}
              />
              <MenuItem icon={<GitBranch aria-hidden="true" />} label="创建永久工作树" disabled />
              <MenuItem
                icon={<Pencil aria-hidden="true" />}
                label="编辑项目"
                onClick={() => act(onRename)}
              />
              <MenuItem icon={<Archive aria-hidden="true" />} label="归档聊天" disabled />
              <MenuItem
                icon={<X aria-hidden="true" />}
                label="移除"
                danger
                onClick={() => act(onRemove)}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function MenuItem({
  icon,
  label,
  danger = false,
  disabled = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`project-menu-item${danger ? " danger" : ""}`}
      role="menuitem"
      disabled={disabled}
      data-tooltip={disabled ? "当前版本尚未支持" : undefined}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
      {disabled ? <small>即将支持</small> : null}
    </button>
  );
}

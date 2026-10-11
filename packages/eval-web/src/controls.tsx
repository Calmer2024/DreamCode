import * as Checkbox from "@radix-ui/react-checkbox";
import * as Dialog from "@radix-ui/react-dialog";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, Cross2Icon } from "@radix-ui/react-icons";
import * as Select from "@radix-ui/react-select";
import { type ReactNode, useId, useState } from "react";

export { Dialog };

export function SelectField({
  value,
  onChange,
  options,
  label,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  label: string;
  id?: string;
}) {
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger id={id} className="select-trigger" aria-label={label}>
        <Select.Value />
        <Select.Icon>
          <ChevronDownIcon />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="select-content" position="popper" sideOffset={6}>
          <Select.ScrollUpButton className="select-scroll">
            <ChevronUpIcon />
          </Select.ScrollUpButton>
          <Select.Viewport>
            {options.map((option) => (
              <Select.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="select-item"
              >
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator>
                  <CheckIcon />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton className="select-scroll">
            <ChevronDownIcon />
          </Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

export function TaskCheckbox({
  id,
  checked,
  onChange,
  label,
  disabled = false,
}: {
  id?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <Checkbox.Root
      id={id}
      className="task-checkbox"
      checked={checked}
      disabled={disabled}
      onCheckedChange={(value) => onChange(value === true)}
      aria-label={label}
    >
      <Checkbox.Indicator className="task-checkbox-indicator">
        <CheckIcon />
      </Checkbox.Indicator>
    </Checkbox.Root>
  );
}

export function DialogSurface({
  title,
  description,
  children,
  className = "launch-dialog",
}: {
  title: string;
  description: string;
  children: ReactNode;
  className?: string;
}) {
  const [returnFocus] = useState(() => document.activeElement as HTMLElement | null);
  return (
    <Dialog.Portal>
      <Dialog.Overlay className="modal-overlay" />
      <Dialog.Content
        className={className}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocus?.isConnected) returnFocus.focus();
          else document.querySelector<HTMLElement>("[data-new-eval-trigger]")?.focus();
        }}
      >
        <header className="modal-header">
          <div>
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Description>{description}</Dialog.Description>
          </div>
          <Dialog.Close className="icon-button" aria-label="关闭">
            <Cross2Icon />
          </Dialog.Close>
        </header>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  );
}

export function Skeleton({ rows = 5 }: { rows?: number }) {
  const id = useId();
  const placeholders = Array.from({ length: rows }, (_, position) => `${id}-${position}`);
  return (
    <div className="skeleton-panel" role="status" aria-label="正在加载">
      <span className="sr-only">正在加载数据</span>
      <div className="skeleton skeleton-heading" />
      {placeholders.map((key) => (
        <div className="skeleton skeleton-row" key={key} />
      ))}
    </div>
  );
}

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import type { DesktopApi } from "../../shared/contracts";

export function TerminalView({
  api,
  terminalId,
  output,
}: {
  api: DesktopApi;
  terminalId: string;
  output: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const writtenLengthRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      fontFamily:
        '"CaskaydiaCove Nerd Font", "Cascadia Code NF", "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      minimumContrastRatio: 4.5,
      scrollback: 10_000,
      scrollOnUserInput: true,
      theme: {
        background: "#ffffff",
        foreground: "#242424",
        cursor: "#242424",
        cursorAccent: "#ffffff",
        selectionBackground: "#cfe3ff",
        black: "#242424",
        red: "#c42b1c",
        green: "#0f7b0f",
        yellow: "#8a6d00",
        blue: "#005fb8",
        magenta: "#7a3e9d",
        cyan: "#008272",
        white: "#d6d6d6",
        brightBlack: "#666666",
        brightRed: "#e74856",
        brightGreen: "#16c60c",
        brightYellow: "#f9f1a5",
        brightBlue: "#3b78ff",
        brightMagenta: "#b4009e",
        brightCyan: "#61d6d6",
        brightWhite: "#242424",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminalRef.current = terminal;
    const input = terminal.onData((data) => void api.writeTerminal(terminalId, data));
    let resizeFrame: number | undefined;
    const fitTerminal = () => {
      resizeFrame = undefined;
      if (!container.isConnected || container.clientWidth === 0 || container.clientHeight === 0)
        return;
      fit.fit();
      void api.resizeTerminal(terminalId, terminal.cols, terminal.rows);
    };
    const resize = new ResizeObserver(() => {
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(fitTerminal);
    });
    resize.observe(container);
    resizeFrame = requestAnimationFrame(fitTerminal);
    terminal.focus();
    return () => {
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      resize.disconnect();
      input.dispose();
      terminal.dispose();
      terminalRef.current = null;
      writtenLengthRef.current = 0;
    };
  }, [api, terminalId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || output.length <= writtenLengthRef.current) return;
    terminal.write(output.slice(writtenLengthRef.current));
    writtenLengthRef.current = output.length;
  }, [output]);

  return (
    <div
      className="terminal-xterm"
      ref={containerRef}
      role="application"
      aria-label="系统终端"
      onPointerDown={() => terminalRef.current?.focus()}
    />
  );
}

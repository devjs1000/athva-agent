import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";

export class TerminalPanel {
  private panel: HTMLElement;
  private resizeHandle: HTMLElement;
  private container: HTMLElement;
  private term: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private projectPath: string = "";
  private shellProcess: any = null;
  private onResize: () => void;
  private isVisible = false;

  constructor(onEditorResize: () => void) {
    this.panel = document.getElementById("terminal-panel")!;
    this.resizeHandle = document.getElementById("terminal-resize")!;
    this.container = document.getElementById("xterm-container")!;
    this.onResize = onEditorResize;

    document.getElementById("btn-close-terminal")?.addEventListener("click", () => this.hide());
    document.getElementById("btn-new-terminal")?.addEventListener("click", () => this.restart());

    this.setupResize();
  }

  setProject(path: string) {
    this.projectPath = path;
    // If terminal is visible, restart with new cwd
    if (this.isVisible && this.term) {
      this.restart();
    }
  }

  toggle() {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  show() {
    if (this.isVisible) return;
    this.panel.classList.remove("hidden");
    this.resizeHandle.classList.remove("hidden");
    this.isVisible = true;

    if (!this.term) {
      this.createTerminal();
    }

    setTimeout(() => {
      this.fit();
      this.onResize();
    }, 0);
  }

  hide() {
    this.panel.classList.add("hidden");
    this.resizeHandle.classList.add("hidden");
    this.isVisible = false;
    this.onResize();
  }

  getIsVisible(): boolean {
    return this.isVisible;
  }

  fit() {
    if (this.fitAddon && this.isVisible) {
      try {
        this.fitAddon.fit();
      } catch {
        // ignore fit errors when not visible
      }
    }
  }

  private createTerminal() {
    this.term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"SF Mono", Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: "#1e1e1e",
        foreground: "#cccccc",
        cursor: "#cccccc",
        selectionBackground: "#264f78",
        black: "#1e1e1e",
        red: "#f44747",
        green: "#6a9955",
        yellow: "#d7ba7d",
        blue: "#569cd6",
        magenta: "#c586c0",
        cyan: "#4ec9b0",
        white: "#d4d4d4",
        brightBlack: "#808080",
        brightRed: "#f44747",
        brightGreen: "#6a9955",
        brightYellow: "#d7ba7d",
        brightBlue: "#569cd6",
        brightMagenta: "#c586c0",
        brightCyan: "#4ec9b0",
        brightWhite: "#ffffff",
      },
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new WebLinksAddon());

    this.term.open(this.container);
    this.fit();

    this.startShell();
  }

  private async startShell() {
    if (!this.term) return;

    const cwd = this.projectPath || ".";

    // Use Tauri's shell plugin to spawn a process
    try {
      const { Command } = await import("@tauri-apps/plugin-shell");

      // Detect shell
      const shell = await this.detectShell();

      const cmd = Command.create(shell, ["-l"], { cwd, encoding: "utf-8" });

      cmd.on("close", () => {
        this.term?.writeln("\r\n\x1b[90m[Process exited]\x1b[0m");
        this.shellProcess = null;
      });

      cmd.on("error", (err: string) => {
        this.term?.writeln(`\r\n\x1b[31mError: ${err}\x1b[0m`);
      });

      cmd.stdout.on("data", (data: string) => {
        this.term?.write(data);
      });

      cmd.stderr.on("data", (data: string) => {
        this.term?.write(data);
      });

      this.shellProcess = await cmd.spawn();

      // Send user input to the shell
      this.term.onData((data: string) => {
        if (this.shellProcess) {
          this.shellProcess.write(data);
        }
      });
    } catch (e) {
      this.term.writeln(`\x1b[31mFailed to start shell: ${e}\x1b[0m`);
      this.term.writeln("\x1b[90mMake sure shell permissions are configured.\x1b[0m");
    }
  }

  private async detectShell(): Promise<string> {
    // Try zsh first (macOS default), then bash, then sh
    try {
      await invoke<boolean>("check_path_exists", { path: "/bin/zsh" });
      return "zsh";
    } catch {
      // fall through
    }
    return "bash";
  }

  private restart() {
    if (this.shellProcess) {
      this.shellProcess.kill();
      this.shellProcess = null;
    }
    if (this.term) {
      this.term.dispose();
      this.term = null;
      this.fitAddon = null;
      this.container.innerHTML = "";
    }
    this.createTerminal();
  }

  private setupResize() {
    let startY: number;
    let startHeight: number;

    const onMouseMove = (e: MouseEvent) => {
      const dy = startY - e.clientY;
      const newHeight = Math.max(100, Math.min(500, startHeight + dy));
      this.panel.style.height = `${newHeight}px`;
      this.fit();
      this.onResize();
    };

    const onMouseUp = () => {
      this.resizeHandle.classList.remove("active");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    this.resizeHandle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startY = e.clientY;
      startHeight = this.panel.getBoundingClientRect().height;
      this.resizeHandle.classList.add("active");
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  }
}

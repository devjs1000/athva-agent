import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";

// Since tauri-plugin-shell doesn't provide a real PTY, we implement
// a command-by-command execution model (like a basic shell prompt).
// Each line the user types is executed as `sh -c "cd <cwd> && <command>"`
// and stdout/stderr is streamed back to xterm.

export class TerminalPanel {
  private panel: HTMLElement;
  private resizeHandle: HTMLElement;
  private container: HTMLElement;
  private term: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private projectPath: string = "";
  private onResize: () => void;
  private isVisible = false;
  private inputBuffer: string = "";
  private isRunning = false;
  private currentProcess: any = null;
  private cwd: string = "";
  private history: string[] = [];
  private historyIndex: number = -1;
  private terminalTheme: any = {
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
  };

  constructor(onEditorResize: () => void) {
    this.panel = document.getElementById("terminal-panel")!;
    this.resizeHandle = document.getElementById("terminal-resize")!;
    this.container = document.getElementById("xterm-container")!;
    this.onResize = onEditorResize;

    document.getElementById("btn-close-terminal")?.addEventListener("click", () => {
      void this.hide();
    });
    document.getElementById("btn-new-terminal")?.addEventListener("click", () => {
      void this.restart();
    });
    document.getElementById("btn-stop-terminal")?.addEventListener("click", () => {
      void this.stopRunningCommand();
    });

    this.setupResize();
  }

  setProject(path: string) {
    this.projectPath = path;
    this.cwd = path;
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
    document.getElementById("btn-toggle-terminal")?.classList.add("active");

    if (!this.term) {
      this.createTerminal();
    }

    setTimeout(() => {
      this.fit();
      this.onResize();
      this.term?.focus();
    }, 0);
  }

  async hide() {
    await this.stopRunningCommand();
    this.panel.classList.add("hidden");
    this.resizeHandle.classList.add("hidden");
    this.isVisible = false;
    document.getElementById("btn-toggle-terminal")?.classList.remove("active");
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
        // ignore
      }
    }
  }

  private createTerminal() {
    this.cwd = this.projectPath || "/";
    this.inputBuffer = "";
    this.isRunning = false;
    this.updateStopButton();

    this.term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"SF Mono", Menlo, Monaco, "Courier New", monospace',
      theme: this.terminalTheme,
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new WebLinksAddon((_event, uri) => {
      import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(uri)).catch(() => {});
    }));

    this.term.open(this.container);
    this.fit();

    // Welcome message
    this.term.writeln("\x1b[90mAthva Terminal\x1b[0m");
    this.printPrompt();

    // Handle user input
    this.term.onData((data) => this.handleInput(data));
  }

  private getShortCwd(): string {
    if (this.cwd === this.projectPath) return ".";
    if (this.cwd.startsWith(this.projectPath + "/")) {
      return this.cwd.substring(this.projectPath.length + 1);
    }
    // Show ~ for home dir
    const home = this.cwd.replace(/^\/Users\/[^/]+/, "~");
    return home;
  }

  private printPrompt() {
    const dir = this.getShortCwd();
    this.term?.write(`\x1b[36m${dir}\x1b[0m \x1b[33m$\x1b[0m `);
  }

  private handleInput(data: string) {
    if (!this.term) return;

    // If a process is running, send data to it (for interactive stdin)
    if (this.isRunning && this.currentProcess) {
      // Ctrl+C to kill
      if (data === "\x03") {
        void this.stopRunningCommand(true);
        return;
      }
      this.currentProcess.write(data);
      return;
    }

    for (let i = 0; i < data.length; i++) {
      const ch = data[i];

      if (ch === "\r" || ch === "\n") {
        // Enter - execute command
        this.term.writeln("");
        const cmd = this.inputBuffer.trim();
        this.inputBuffer = "";
        this.historyIndex = -1;
        if (cmd) {
          this.history.push(cmd);
          this.executeCommand(cmd);
        } else {
          this.printPrompt();
        }
      } else if (ch === "\x7f" || ch === "\b") {
        // Backspace
        if (this.inputBuffer.length > 0) {
          this.inputBuffer = this.inputBuffer.slice(0, -1);
          this.term.write("\b \b");
        }
      } else if (ch === "\x03") {
        // Ctrl+C
        this.inputBuffer = "";
        this.term.writeln("^C");
        this.printPrompt();
      } else if (ch === "\x0c") {
        // Ctrl+L - clear
        this.term.clear();
        this.inputBuffer = "";
        this.printPrompt();
      } else if (data.startsWith("\x1b[A", i)) {
        // Up arrow - history back
        i += 2; // skip [A
        if (this.history.length > 0) {
          if (this.historyIndex === -1) {
            this.historyIndex = this.history.length - 1;
          } else if (this.historyIndex > 0) {
            this.historyIndex--;
          }
          this.replaceInput(this.history[this.historyIndex]);
        }
      } else if (data.startsWith("\x1b[B", i)) {
        // Down arrow - history forward
        i += 2;
        if (this.historyIndex !== -1) {
          if (this.historyIndex < this.history.length - 1) {
            this.historyIndex++;
            this.replaceInput(this.history[this.historyIndex]);
          } else {
            this.historyIndex = -1;
            this.replaceInput("");
          }
        }
      } else if (ch >= " ") {
        // Regular character
        this.inputBuffer += ch;
        this.term.write(ch);
      }
    }
  }

  private replaceInput(newInput: string) {
    if (!this.term) return;
    // Erase current input
    for (let j = 0; j < this.inputBuffer.length; j++) {
      this.term.write("\b \b");
    }
    this.inputBuffer = newInput;
    this.term.write(newInput);
  }

  // Run a command externally (from script runner etc.) - shows terminal, prints command, executes
  async runCommand(command: string) {
    this.show();
    if (this.isRunning) return; // don't interrupt running process
    // Print the command as if user typed it
    this.term?.writeln(`\x1b[90m$ ${command}\x1b[0m`);
    await this.executeCommand(command);
  }

  private async executeCommand(command: string) {
    if (!this.term) return;

    // Handle built-in cd
    if (command === "cd" || command.startsWith("cd ")) {
      this.handleCd(command);
      return;
    }

    // Handle clear
    if (command === "clear" || command === "cls") {
      this.term.clear();
      this.printPrompt();
      return;
    }

    // Handle exit
    if (command === "exit") {
      this.hide();
      return;
    }

    this.isRunning = true;
    this.updateStopButton();

    try {
      const { Command } = await import("@tauri-apps/plugin-shell");

      // Use zsh login shell so ~/.zprofile / ~/.zshrc are sourced,
      // giving access to nvm, homebrew, volta, etc.
      const cmd = Command.create("zsh", ["-l", "-c", `cd "${this.cwd}" && ${command}`], {
        encoding: "utf-8",
      });

      cmd.stdout.on("data", (data: string) => {
        // Convert \n to \r\n for xterm
        this.term?.write(data.replace(/\n/g, "\r\n"));
      });

      cmd.stderr.on("data", (data: string) => {
        this.term?.write(data.replace(/\n/g, "\r\n"));
      });

      cmd.on("close", (payload: { code: number | null }) => {
        this.isRunning = false;
        this.currentProcess = null;
        this.updateStopButton();
        if (payload.code !== 0 && payload.code !== null) {
          this.term?.writeln(`\x1b[90m[exit ${payload.code}]\x1b[0m`);
        }
        this.printPrompt();
      });

      cmd.on("error", (err: string) => {
        this.isRunning = false;
        this.currentProcess = null;
        this.updateStopButton();
        this.term?.writeln(`\x1b[31m${err}\x1b[0m`);
        this.printPrompt();
      });

      this.currentProcess = await cmd.spawn();
    } catch (e) {
      this.isRunning = false;
      this.updateStopButton();
      this.term.writeln(`\x1b[31mError: ${e}\x1b[0m`);
      this.printPrompt();
    }
  }

  private async handleCd(command: string) {
    const arg = command.substring(2).trim();
    let newPath: string;

    if (!arg || arg === "~") {
      // cd home
      newPath = this.projectPath;
    } else if (arg === "-") {
      newPath = this.projectPath;
    } else if (arg.startsWith("/")) {
      newPath = arg;
    } else {
      newPath = `${this.cwd}/${arg}`;
    }

    // Resolve .. and .
    try {
      // Use the Rust backend to check if path exists
      const exists = await invoke<boolean>("check_path_exists", { path: newPath });
      if (exists) {
        this.cwd = newPath;
      } else {
        this.term?.writeln(`\x1b[31mcd: no such directory: ${arg}\x1b[0m`);
      }
    } catch {
      this.term?.writeln(`\x1b[31mcd: ${arg}: error\x1b[0m`);
    }

    this.printPrompt();
  }

  private async restart() {
    await this.stopRunningCommand();
    if (this.term) {
      this.term.dispose();
      this.term = null;
      this.fitAddon = null;
      this.container.innerHTML = "";
    }
    this.history = [];
    this.historyIndex = -1;
    this.createTerminal();
  }

  private updateStopButton() {
    const stopBtn = document.getElementById("btn-stop-terminal");
    if (!stopBtn) return;
    stopBtn.classList.toggle("hidden", !this.isRunning);
  }

  private async stopRunningCommand(fromKeyboard = false) {
    if (!this.currentProcess) return;

    const process = this.currentProcess;
    const pid = typeof process.pid === "number" ? process.pid : null;

    this.currentProcess = null;
    this.isRunning = false;
    this.updateStopButton();

    try {
      if (pid !== null) {
        await invoke("kill_process_tree", { pid });
      } else {
        await process.kill();
      }
    } catch {
      try {
        await process.kill();
      } catch {
        // ignore secondary kill failure
      }
    }

    if (fromKeyboard) {
      this.term?.writeln("^C");
      this.printPrompt();
    }
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

  setTheme(colors: any, isLight: boolean) {
    this.terminalTheme = {
      ...this.terminalTheme,
      background: colors.editorBg,
      foreground: isLight ? "#1f1f1f" : "#cccccc",
      cursor: isLight ? "#1f1f1f" : "#cccccc",
      selectionBackground: isLight ? "rgba(0, 0, 0, 0.1)" : "#264f78",
      black: isLight ? "#ffffff" : "#1e1e1e",
      white: isLight ? "#1e1e1e" : "#d4d4d4",
    };
    if (this.term) {
      this.term.options.theme = this.terminalTheme;
    }
  }
}

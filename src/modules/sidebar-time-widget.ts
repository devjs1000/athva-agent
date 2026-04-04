import { showConfirmDialog } from "./dialogs";

type SidebarTimeMode = "clock" | "stopwatch" | "timer";

export class SidebarTimeWidget {
  private root: HTMLElement;
  private displayEl: HTMLElement;
  private subtextEl: HTMLElement;
  private timerControlsEl: HTMLElement;
  private minutesEl: HTMLInputElement;
  private secondsEl: HTMLInputElement;
  private startBtn: HTMLButtonElement;
  private resetBtn: HTMLButtonElement;
  private modeButtons: HTMLButtonElement[];

  private mode: SidebarTimeMode = "clock";
  private tickHandle: number | null = null;

  private stopwatchRunning = false;
  private stopwatchStartedAt = 0;
  private stopwatchElapsedMs = 0;

  private timerRunning = false;
  private timerEndsAt = 0;
  private timerRemainingMs = 0;
  private timerAlertOpen = false;

  constructor(rootId: string) {
    this.root = document.getElementById(rootId)!;
    this.displayEl = document.getElementById("sidebar-time-display")!;
    this.subtextEl = document.getElementById("sidebar-time-subtext")!;
    this.timerControlsEl = document.getElementById("sidebar-timer-controls")!;
    this.minutesEl = document.getElementById("sidebar-timer-minutes") as HTMLInputElement;
    this.secondsEl = document.getElementById("sidebar-timer-seconds") as HTMLInputElement;
    this.startBtn = document.getElementById("sidebar-time-start") as HTMLButtonElement;
    this.resetBtn = document.getElementById("sidebar-time-reset") as HTMLButtonElement;
    this.modeButtons = Array.from(this.root.querySelectorAll<HTMLButtonElement>(".sidebar-time-mode"));

    this.bindEvents();
    this.switchMode("clock");
    this.startTicker();
  }

  private bindEvents() {
    this.modeButtons.forEach((button) => {
      button.addEventListener("click", () => {
        this.switchMode(button.dataset.mode as SidebarTimeMode);
      });
    });

    this.startBtn.addEventListener("click", () => {
      if (this.mode === "stopwatch") {
        this.toggleStopwatch();
        return;
      }
      if (this.mode === "timer") {
        this.toggleTimer();
      }
    });

    this.resetBtn.addEventListener("click", () => {
      if (this.mode === "stopwatch") {
        this.stopwatchRunning = false;
        this.stopwatchStartedAt = 0;
        this.stopwatchElapsedMs = 0;
      } else if (this.mode === "timer") {
        this.timerRunning = false;
        this.timerEndsAt = 0;
        this.timerRemainingMs = 0;
      }
      this.render();
    });

    [this.minutesEl, this.secondsEl].forEach((input) => {
      input.addEventListener("input", () => {
        if (this.mode === "timer" && !this.timerRunning) {
          this.timerRemainingMs = this.readTimerInputMs();
          this.render();
        }
      });
    });
  }

  private startTicker() {
    if (this.tickHandle !== null) {
      window.clearInterval(this.tickHandle);
    }
    this.tickHandle = window.setInterval(() => this.tick(), 200);
  }

  private tick() {
    if (this.mode === "timer" && this.timerRunning) {
      const remaining = Math.max(0, this.timerEndsAt - Date.now());
      this.timerRemainingMs = remaining;
      if (remaining === 0) {
        this.timerRunning = false;
        this.timerEndsAt = 0;
        if (!this.timerAlertOpen) {
          this.timerAlertOpen = true;
          void showConfirmDialog("Timer Complete", "Your timer has finished.", "OK").finally(() => {
            this.timerAlertOpen = false;
          });
        }
      }
    }
    this.render();
  }

  private switchMode(mode: SidebarTimeMode) {
    this.mode = mode;
    this.modeButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === mode);
    });
    this.render();
  }

  private toggleStopwatch() {
    if (this.stopwatchRunning) {
      this.stopwatchElapsedMs += Date.now() - this.stopwatchStartedAt;
      this.stopwatchRunning = false;
      this.stopwatchStartedAt = 0;
    } else {
      this.stopwatchRunning = true;
      this.stopwatchStartedAt = Date.now();
    }
    this.render();
  }

  private toggleTimer() {
    if (this.timerRunning) {
      this.timerRemainingMs = Math.max(0, this.timerEndsAt - Date.now());
      this.timerRunning = false;
      this.timerEndsAt = 0;
      this.writeTimerInputsFromMs(this.timerRemainingMs);
      this.render();
      return;
    }

    const durationMs = this.timerRemainingMs > 0 ? this.timerRemainingMs : this.readTimerInputMs();
    if (durationMs <= 0) return;

    this.timerRemainingMs = durationMs;
    this.timerEndsAt = Date.now() + durationMs;
    this.timerRunning = true;
    this.render();
  }

  private render() {
    this.timerControlsEl.classList.toggle("hidden", this.mode !== "timer");
    this.startBtn.classList.toggle("hidden", this.mode === "clock");
    this.resetBtn.classList.toggle("hidden", this.mode === "clock");

    if (this.mode === "clock") {
      const now = new Date();
      this.displayEl.textContent = now.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      this.subtextEl.textContent = now.toLocaleDateString([], {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      return;
    }

    if (this.mode === "stopwatch") {
      const elapsed = this.stopwatchElapsedMs + (this.stopwatchRunning ? Date.now() - this.stopwatchStartedAt : 0);
      this.displayEl.textContent = this.formatDuration(elapsed, true);
      this.subtextEl.textContent = this.stopwatchRunning ? "Stopwatch running" : "Stopwatch paused";
      this.startBtn.textContent = this.stopwatchRunning ? "Pause" : "Start";
      this.resetBtn.textContent = "Reset";
      return;
    }

    const remaining = this.timerRunning ? Math.max(0, this.timerEndsAt - Date.now()) : this.timerRemainingMs;
    if (!this.timerRunning) {
      this.timerRemainingMs = this.readTimerInputMs();
    }
    this.displayEl.textContent = this.formatDuration(remaining, false);
    this.subtextEl.textContent = this.timerRunning ? "Timer running" : "Set a timer";
    this.startBtn.textContent = this.timerRunning ? "Pause" : "Start";
    this.resetBtn.textContent = "Reset";

    if (!this.timerRunning) {
      this.writeTimerInputsFromMs(this.timerRemainingMs);
    }
  }

  private readTimerInputMs(): number {
    const minutes = Math.max(0, Number.parseInt(this.minutesEl.value || "0", 10) || 0);
    const seconds = Math.max(0, Math.min(59, Number.parseInt(this.secondsEl.value || "0", 10) || 0));
    return (minutes * 60 + seconds) * 1000;
  }

  private writeTimerInputsFromMs(ms: number) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    this.minutesEl.value = String(minutes);
    this.secondsEl.value = String(seconds).padStart(2, "0");
  }

  private formatDuration(ms: number, withHundredths: boolean): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (withHundredths) {
      const hundredths = Math.floor((ms % 1000) / 10);
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
    }

    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
}

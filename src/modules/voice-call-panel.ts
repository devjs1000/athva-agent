import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface Peer {
  id: { "0": string } | string;
  name: string;
  ip_address: string;
  port: number;
  last_seen: number;
}

interface CallStateEvent {
  callId: string;
  state: string;
}

interface CallEndedEvent {
  callId: string;
  reason: string;
}

function peerId(p: Peer): string {
  return typeof p.id === "string" ? p.id : (p.id as { "0": string })["0"];
}

export class VoiceCallPanel {
  private panelEl: HTMLElement;
  private peersListEl: HTMLElement;
  private callViewEl: HTMLElement;
  private incomingModalEl: HTMLElement;
  private statusEl: HTMLElement;
  private timerEl: HTMLElement;
  private muteBtn: HTMLButtonElement;
  private endCallBtn: HTMLButtonElement;
  private acceptBtn: HTMLButtonElement;
  private rejectBtn: HTMLButtonElement;
  private incomingNameEl: HTMLElement;

  private peers: Peer[] = [];
  private activeCallId: string | null = null;
  private pendingCallId: string | null = null;
  private pendingCallerName: string | null = null;
  private muted = false;
  private callStartTime: number | null = null;
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private unlisten: UnlistenFn[] = [];
  private visible = false;

  constructor(panelId: string) {
    this.panelEl = document.getElementById(panelId)!;
    this.peersListEl = this.panelEl.querySelector(".voice-peers-list")!;
    this.callViewEl = this.panelEl.querySelector(".voice-call-view")!;
    this.incomingModalEl = this.panelEl.querySelector(".voice-incoming-modal")!;
    this.statusEl = this.panelEl.querySelector(".voice-call-status")!;
    this.timerEl = this.panelEl.querySelector(".voice-call-timer")!;
    this.muteBtn = this.panelEl.querySelector("#btn-voice-mute") as HTMLButtonElement;
    this.endCallBtn = this.panelEl.querySelector("#btn-voice-end") as HTMLButtonElement;
    this.acceptBtn = this.panelEl.querySelector("#btn-voice-accept") as HTMLButtonElement;
    this.rejectBtn = this.panelEl.querySelector("#btn-voice-reject") as HTMLButtonElement;
    this.incomingNameEl = this.panelEl.querySelector(".voice-incoming-name")!;

    this.panelEl.querySelector("#btn-close-voice-call")?.addEventListener("click", () => this.hide());
    this.muteBtn.addEventListener("click", () => this.toggleMute());
    this.endCallBtn.addEventListener("click", () => void this.endCall());
    this.acceptBtn.addEventListener("click", () => void this.acceptCall());
    this.rejectBtn.addEventListener("click", () => void this.rejectCall());

    void this.wireEvents();
  }

  private async wireEvents() {
    this.unlisten.push(
      await listen<CallStateEvent>("voice:call-state-changed", (e) => {
        if (e.payload.state === "RINGING") {
          this.showCallView("Calling…");
        }
      }),
      await listen<{ callId: string }>("voice:call-established", (e) => {
        this.activeCallId = e.payload.callId;
        this.startTimer();
        this.showCallView("Connected");
      }),
      await listen<CallEndedEvent>("voice:call-ended", () => {
        this.resetCallState();
      }),
      await listen<{ callId: string; callerName: string }>("voice:incoming-call", (e) => {
        this.pendingCallId = e.payload.callId;
        this.pendingCallerName = e.payload.callerName ?? "Unknown";
        this.showIncomingModal();
      }),
    );
  }

  show() {
    this.panelEl.classList.remove("hidden");
    this.visible = true;
    void this.refreshPeers();
    this.pollInterval = setInterval(() => void this.refreshPeers(), 10_000);
  }

  hide() {
    this.panelEl.classList.add("hidden");
    this.visible = false;
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  isVisible() {
    return this.visible;
  }

  destroy() {
    this.unlisten.forEach((u) => u());
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.timerInterval) clearInterval(this.timerInterval);
  }

  private async refreshPeers() {
    try {
      this.peers = (await invoke<Peer[]>("voice_get_peers")) ?? [];
      this.renderPeers();
    } catch {
      // silently fail — network may not be ready
    }
  }

  private renderPeers() {
    if (this.peers.length === 0) {
      this.peersListEl.innerHTML = `<div class="voice-peers-empty">No peers found on this network.</div>`;
      return;
    }
    this.peersListEl.innerHTML = this.peers
      .map((p) => {
        const id = peerId(p);
        const name = this.esc(p.name);
        const ip = this.esc(p.ip_address);
        return `
          <div class="voice-peer-item" data-peer-id="${id}">
            <span class="voice-peer-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
              </svg>
            </span>
            <span class="voice-peer-name">${name}</span>
            <span class="voice-peer-ip">${ip}</span>
            <button class="voice-call-btn btn-icon" data-peer-id="${id}" title="Call ${name}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.18 2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.54a16 16 0 0 0 6.07 6.07l.98-.98a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
              </svg>
            </button>
          </div>`;
      })
      .join("");

    this.peersListEl.querySelectorAll(".voice-call-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const pid = (e.currentTarget as HTMLElement).dataset.peerId!;
        void this.initiateCall(pid);
      });
    });
  }

  private async initiateCall(peerId: string) {
    try {
      const callId = await invoke<string>("voice_initiate_call", { peerId });
      this.activeCallId = callId;
      this.showCallView("Calling…");
    } catch (err) {
      console.error("Call failed:", err);
    }
  }

  private async acceptCall() {
    if (!this.pendingCallId) return;
    try {
      await invoke("voice_accept_call", { callId: this.pendingCallId });
      this.activeCallId = this.pendingCallId;
      this.pendingCallId = null;
      this.incomingModalEl.classList.add("hidden");
      this.startTimer();
      this.showCallView("Connected");
    } catch (err) {
      console.error("Accept failed:", err);
    }
  }

  private async rejectCall() {
    if (!this.pendingCallId) return;
    try {
      await invoke("voice_reject_call", { callId: this.pendingCallId });
    } catch {
      // ignore
    }
    this.pendingCallId = null;
    this.incomingModalEl.classList.add("hidden");
  }

  private async endCall() {
    if (!this.activeCallId) return;
    try {
      await invoke("voice_end_call", { callId: this.activeCallId });
    } catch {
      // ignore
    }
    this.resetCallState();
  }

  private toggleMute() {
    this.muted = !this.muted;
    this.muteBtn.classList.toggle("active", this.muted);
    this.muteBtn.title = this.muted ? "Unmute" : "Mute";
  }

  private showCallView(status: string) {
    this.statusEl.textContent = status;
    this.callViewEl.classList.remove("hidden");
  }

  private showIncomingModal() {
    this.incomingNameEl.textContent = this.pendingCallerName ?? "Unknown";
    this.incomingModalEl.classList.remove("hidden");
  }

  private startTimer() {
    this.callStartTime = Date.now();
    this.timerInterval = setInterval(() => {
      if (!this.callStartTime) return;
      const elapsed = Math.floor((Date.now() - this.callStartTime) / 1000);
      const m = Math.floor(elapsed / 60).toString().padStart(2, "0");
      const s = (elapsed % 60).toString().padStart(2, "0");
      this.timerEl.textContent = `${m}:${s}`;
    }, 1000);
  }

  private resetCallState() {
    this.activeCallId = null;
    this.callStartTime = null;
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.timerEl.textContent = "00:00";
    this.callViewEl.classList.add("hidden");
    this.incomingModalEl.classList.add("hidden");
    this.muted = false;
    this.muteBtn.classList.remove("active");
  }

  private esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
}

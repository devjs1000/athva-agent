/**
 * Screen Saver Module
 * Supports custom image or built-in canvas animations.
 * Activates after a user-configurable idle timeout.
 */

import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";

// ── Types ──

export type ScreenSaverAnimation =
  | "matrix"
  | "starfield"
  | "particle-waves"
  | "digital-clock"
  | "aurora"
  | "golden-ratio"
  | "life"
  | "atoms"
  | "galaxy"
  | "solar-system"
  | "uzumaki"
  | "editor-skeleton"
  | "slimes"
  | "file-names"
  | "project-structure"
  | "cosmos"
  | "black-hole"
  | "three-body"
  | "neurons"
  | "dimensional-travel"
  | "eyes"
  | "face"
  | "forest"
  | "chatting"
  | "code-minimap"
  | "single-eye"
  | "ai"
  | "api-request"
  | "earth"
  | "minecraft"
  | "camera-pixelated"
  | "camera-matrix"
  | "roblox"
  | "audio-waves"
  | "ai-agents"
  | "pokemon";

export type ScreenSaverMode = "animation" | "image";

export interface ScreenSaverSettings {
  enabled: boolean;
  timeoutMinutes: number;
  mode: ScreenSaverMode;
  animation: ScreenSaverAnimation;
  imageUrl: string; // data-url stored
}

export const DEFAULT_SCREEN_SAVER_SETTINGS: ScreenSaverSettings = {
  enabled: false,
  timeoutMinutes: 5,
  mode: "animation",
  animation: "matrix",
  imageUrl: "",
};

export interface ScreenSaverAnimationOption {
  id: ScreenSaverAnimation;
  label: string;
  description: string;
  requiresCamera?: boolean;
  requiresMic?: boolean;
}

export const ANIMATION_OPTIONS: ScreenSaverAnimationOption[] = [
  { id: "matrix", label: "Matrix Rain", description: "Cascading green characters" },
  { id: "starfield", label: "Starfield", description: "Infinite hyperspace stars" },
  { id: "particle-waves", label: "Particle Waves", description: "Flowing particle ocean" },
  { id: "digital-clock", label: "Digital Clock", description: "Floating time display with particles" },
  { id: "aurora", label: "Aurora Borealis", description: "Northern lights shimmer" },
  { id: "golden-ratio", label: "Golden Ratio", description: "Spinning golden spirals" },
  { id: "life", label: "Game of Life", description: "Conway's cellular automaton" },
  { id: "atoms", label: "Atoms", description: "Electrons orbiting nucleus" },
  { id: "galaxy", label: "Galaxy", description: "Swirling galactic particles" },
  { id: "solar-system", label: "Solar System", description: "Sun and orbiting planets" },
  { id: "uzumaki", label: "Uzumaki Spiral", description: "Hypnotic swirling spiral" },
  { id: "editor-skeleton", label: "Editor Loading", description: "Animated code skeleton" },
  { id: "slimes", label: "Slimes", description: "Bouncing blobby slimes" },
  { id: "file-names", label: "Files & Folders", description: "Floating project paths" },
  { id: "project-structure", label: "Project Tree", description: "Dynamic directory tree" },
  { id: "cosmos", label: "Cosmos", description: "Deep space cosmic clouds" },
  { id: "black-hole", label: "Black Hole", description: "Event horizon and accretion disk" },
  { id: "three-body", label: "Three-Body Problem", description: "Chaotic mass rotation" },
  { id: "neurons", label: "Neural Network", description: "Firing synapses" },
  { id: "dimensional-travel", label: "Dimensional Travel", description: "Hyperspace grid warp" },
  { id: "eyes", label: "Watching Eyes", description: "Blinking and looking around" },
  { id: "face", label: "Wireframe Face", description: "Abstract geometric face", requiresMic: true },
  { id: "forest", label: "Forest", description: "Scrolling tree silhouettes" },
  { id: "chatting", label: "Chatting", description: "Animated speech bubbles" },
  { id: "code-minimap", label: "Code Minimap", description: "Scrolling code structure" },
  { id: "single-eye", label: "Single Eye", description: "A solitary watching eye" },
  { id: "ai", label: "AI Core", description: "Glowing artificial intelligence core" },
  { id: "api-request", label: "API Requests", description: "Simulated network traffic" },
  { id: "earth", label: "Earth Globe", description: "Rotating wireframe planet" },
  { id: "minecraft", label: "Voxel Terrain", description: "Isometric block generation" },
  { id: "camera-pixelated", label: "Pixel Cam", description: "Live pixelated webcam", requiresCamera: true },
  { id: "camera-matrix", label: "Matrix Cam", description: "Live webcam as Matrix code", requiresCamera: true },
  { id: "roblox", label: "Roblox", description: "Blocky characters bouncing" },
  { id: "audio-waves", label: "Audio Waves", description: "Microphone sound visualization", requiresMic: true },
  { id: "ai-agents", label: "AI Agents", description: "Swarm of interacting agents" },
  { id: "pokemon", label: "Pokemon", description: "Bouncing Pokeballs" }
];

// ── Helpers ──

async function pathToDataUrl(filePath: string): Promise<string | null> {
  try {
    const bytes = await readFile(filePath);
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "png";
    const mimeMap: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
      gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    };
    const mime = mimeMap[ext] ?? "image/png";
    const blob = new Blob([bytes], { type: mime });
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

// ── Screen Saver Class ──

export class ScreenSaver {
  private settings: ScreenSaverSettings;
  private overlay: HTMLElement;
  private canvas: HTMLCanvasElement;
  private imageEl: HTMLElement;
  private idleTimer: number | null = null;
  private isActive = false;
  private boundReset: () => void;
  private cleanupAnimation?: () => void;

  constructor() {
    this.settings = { ...DEFAULT_SCREEN_SAVER_SETTINGS };

    this.overlay = document.createElement("div");
    this.overlay.id = "screensaver-overlay";
    this.overlay.className = "screensaver-overlay hidden";

    this.canvas = document.createElement("canvas");
    this.canvas.className = "screensaver-canvas";
    this.overlay.appendChild(this.canvas);

    this.imageEl = document.createElement("div");
    this.imageEl.className = "screensaver-image hidden";
    this.overlay.appendChild(this.imageEl);

    const hint = document.createElement("div");
    hint.className = "screensaver-hint";
    hint.textContent = "Move mouse or press any key to dismiss";
    this.overlay.appendChild(hint);

    document.body.appendChild(this.overlay);

    this.boundReset = () => this.onUserActivity();

    const events: (keyof WindowEventMap)[] = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "wheel"];
    events.forEach((evt) => window.addEventListener(evt, this.boundReset, { passive: true }));

    window.addEventListener("resize", () => {
      if (this.isActive) {
        this.sizeCanvas();
        this.startAnimation(); 
      }
    });
  }

  updateSettings(settings: ScreenSaverSettings) {
    this.settings = { ...settings };
    this.resetIdleTimer();
  }

  getSettings(): ScreenSaverSettings {
    return { ...this.settings };
  }

  async pickImage(): Promise<string | null> {
    const path = await open({
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
    });
    if (typeof path === "string") {
      return await pathToDataUrl(path);
    }
    return null;
  }

  preview(overrideSettings?: ScreenSaverSettings) {
    if (overrideSettings) {
      this.settings = { ...overrideSettings };
    }
    const wasEnabled = this.settings.enabled;
    this.settings.enabled = true;
    this.activate();
    this.settings.enabled = wasEnabled;
  }

  private onUserActivity() {
    if (this.isActive) {
      this.dismiss();
    }
    this.resetIdleTimer();
  }

  private resetIdleTimer() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.settings.enabled) return;
    const ms = this.settings.timeoutMinutes * 60 * 1000;
    if (ms <= 0) return;
    this.idleTimer = window.setTimeout(() => this.activate(), ms);
  }

  private sizeCanvas() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  private activate() {
    if (this.isActive) return;
    this.isActive = true;
    this.sizeCanvas();
    this.overlay.classList.remove("hidden");

    if (this.settings.mode === "image" && this.settings.imageUrl) {
      this.canvas.classList.add("hidden");
      this.imageEl.classList.remove("hidden");
      this.imageEl.style.backgroundImage = `url("${this.settings.imageUrl}")`;
    } else {
      this.canvas.classList.remove("hidden");
      this.imageEl.classList.add("hidden");
      this.startAnimation();
    }
  }

  private dismiss() {
    this.isActive = false;
    this.overlay.classList.add("hidden");
    if (this.cleanupAnimation) {
      this.cleanupAnimation();
      this.cleanupAnimation = undefined;
    }
  }

  private startAnimation() {
    if (this.cleanupAnimation) {
      this.cleanupAnimation();
    }
    this.cleanupAnimation = runAnimationLoop(this.settings.animation, this.canvas);
  }
}

// ── Standalone Animation Engine ──

export function runAnimationLoop(id: ScreenSaverAnimation, canvas: HTMLCanvasElement, isPreview: boolean = false): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  
  let active = true;
  let animId = 0;
  
  const runners: Record<ScreenSaverAnimation, (w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) => void> = {
    "matrix": animateMatrix,
    "starfield": animateStarfield,
    "particle-waves": animateParticleWaves,
    "digital-clock": animateDigitalClock,
    "aurora": animateAurora,
    "golden-ratio": animateGoldenRatio,
    "life": animateLife,
    "atoms": animateAtoms,
    "galaxy": animateGalaxy,
    "solar-system": animateSolarSystem,
    "uzumaki": animateUzumaki,
    "editor-skeleton": animateEditorSkeleton,
    "slimes": animateSlimes,
    "file-names": animateFileNames,
    "project-structure": animateProjectStructure,
    "cosmos": animateCosmos,
    "black-hole": animateBlackHole,
    "three-body": animateThreeBody,
    "neurons": animateNeurons,
    "dimensional-travel": animateDimensionalTravel,
    "eyes": animateEyes,
    "face": animateFace,
    "forest": animateForest,
    "chatting": animateChatting,
    "code-minimap": animateCodeMinimap,
    "single-eye": animateSingleEye,
    "ai": animateAi,
    "api-request": animateApiRequest,
    "earth": animateEarth,
    "minecraft": animateMinecraft,
    "camera-pixelated": animateCameraPixelated,
    "camera-matrix": animateCameraMatrix,
    "roblox": animateRoblox,
    "audio-waves": animateAudioWaves,
    "ai-agents": animateAiAgents,
    "pokemon": animatePokemon,
  };

  const runner = runners[id] || runners["matrix"];
  const opt = ANIMATION_OPTIONS.find(o => o.id === id);
  const w = canvas.width;
  const h = canvas.height;

  if ((opt?.requiresCamera || opt?.requiresMic) && isPreview) {
    let cameraEnabled = false;
    
    const drawPlaceholder = () => {
      ctx.fillStyle = "#1e1e1e"; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#a8a8a8"; ctx.font = "12px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("Click to enable", w/2, h/2 - 8);
      ctx.fillText(opt.requiresCamera ? "Camera" : "Microphone", w/2, h/2 + 8);
    };
    drawPlaceholder();
    
    const clickHandler = () => {
      cameraEnabled = true;
      canvas.removeEventListener('click', clickHandler);
      canvas.style.cursor = "default";
      runner(w, h, ctx, () => active, (reqId) => { animId = reqId; });
    };
    canvas.addEventListener('click', clickHandler);
    canvas.style.cursor = "pointer";
    
    return () => {
      active = false;
      canvas.removeEventListener('click', clickHandler);
      canvas.style.cursor = "default";
      if (cameraEnabled) cancelAnimationFrame(animId);
    };
  }

  runner(w, h, ctx, () => active, (reqId) => { animId = reqId; });

  return () => {
    active = false;
    cancelAnimationFrame(animId);
  };
}

// ── Animation Implementations ──

function animateMatrix(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const fontSize = Math.max(10, Math.floor(w / 100));
  const cols = Math.floor(w / fontSize) || 1;
  const drops = new Array(cols).fill(1);
  const chars = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEF";

  const draw = () => {
    ctx.fillStyle = "rgba(0, 0, 0, 0.05)";
    ctx.fillRect(0, 0, w, h);
    ctx.font = `${fontSize}px 'JetBrains Mono', monospace`;

    for (let i = 0; i < drops.length; i++) {
      const char = chars[Math.floor(Math.random() * chars.length)];
      const brightness = Math.random();
      if (brightness > 0.95) ctx.fillStyle = "#ffffff";
      else if (brightness > 0.8) ctx.fillStyle = "#39ff14";
      else ctx.fillStyle = `rgba(0, ${150 + Math.floor(Math.random() * 105)}, 0, ${0.6 + Math.random() * 0.4})`;
      
      ctx.fillText(char, i * fontSize, drops[i] * fontSize);
      if (drops[i] * fontSize > h && Math.random() > 0.975) drops[i] = 0;
      drops[i]++;
    }
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
  draw();
}

function animateStarfield(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const numStars = Math.min(600, Math.floor(w * h / 2000));
  const stars: { x: number; y: number; z: number }[] = [];
  const cx = w / 2; const cy = h / 2;

  for (let i = 0; i < numStars; i++) {
    stars.push({ x: (Math.random() - 0.5) * w * 2, y: (Math.random() - 0.5) * h * 2, z: Math.random() * w });
  }

  const draw = () => {
    ctx.fillStyle = "rgba(0, 0, 8, 0.25)"; ctx.fillRect(0, 0, w, h);
    for (const star of stars) {
      star.z -= w * 0.002; 
      if (star.z <= 0) {
        star.x = (Math.random() - 0.5) * w * 2; star.y = (Math.random() - 0.5) * h * 2; star.z = w;
      }
      const sx = cx + (star.x / star.z) * 300; const sy = cy + (star.y / star.z) * 300;
      const r = Math.max(0, (1 - star.z / w) * 3); const alpha = Math.max(0, 1 - star.z / w);
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(200, 220, 255, ${alpha})`; ctx.fill();

      const prevZ = star.z + w * 0.002;
      const psx = cx + (star.x / prevZ) * 300; const psy = cy + (star.y / prevZ) * 300;
      ctx.beginPath(); ctx.moveTo(psx, psy); ctx.lineTo(sx, sy);
      ctx.strokeStyle = `rgba(160, 200, 255, ${alpha * 0.3})`; ctx.lineWidth = r * 0.5; ctx.stroke();
    }
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  ctx.fillStyle = "#000008"; ctx.fillRect(0, 0, w, h); draw();
}

function animateParticleWaves(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const particles: { x: number; baseY: number; amplitude: number; frequency: number; speed: number; size: number; hue: number }[] = [];
  const count = Math.min(200, Math.floor(w / 4));
  for (let i = 0; i < count; i++) {
    particles.push({
      x: Math.random() * w, baseY: h * 0.3 + Math.random() * h * 0.4,
      amplitude: 10 + Math.random() * h * 0.1, frequency: 0.002 + Math.random() * 0.004,
      speed: 0.3 + Math.random() * 0.8, size: 1.5 + Math.random() * 3, hue: 200 + Math.random() * 60,
    });
  }
  let time = 0;
  const draw = () => {
    ctx.fillStyle = "rgba(8, 10, 20, 0.08)"; ctx.fillRect(0, 0, w, h);
    for (const p of particles) {
      p.x += p.speed; if (p.x > w + 10) p.x = -10;
      const y = p.baseY + Math.sin(p.x * p.frequency + time * 0.02) * p.amplitude;
      const alpha = 0.4 + 0.4 * Math.sin(time * 0.01 + p.x * 0.01);
      ctx.beginPath(); ctx.arc(p.x, y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${p.hue}, 80%, 65%, ${alpha})`; ctx.fill();
    }
    time++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  ctx.fillStyle = "#080a14"; ctx.fillRect(0, 0, w, h); draw();
}

function animateDigitalClock(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const dots: { x: number; y: number; vx: number; vy: number; alpha: number }[] = [];
  for (let i = 0; i < Math.min(80, Math.floor(w / 10)); i++) {
    dots.push({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4, alpha: 0.1 + Math.random() * 0.3 });
  }
  const draw = () => {
    ctx.fillStyle = "rgba(5, 5, 15, 0.12)"; ctx.fillRect(0, 0, w, h);
    for (const d of dots) {
      d.x += d.vx; d.y += d.vy;
      if (d.x < 0 || d.x > w) d.vx *= -1;
      if (d.y < 0 || d.y > h) d.vy *= -1;
      ctx.beginPath(); ctx.arc(d.x, d.y, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(100, 180, 255, ${d.alpha})`; ctx.fill();
    }
    for (let i = 0; i < dots.length; i++) {
      for (let j = i + 1; j < dots.length; j++) {
        const dist = Math.hypot(dots[i].x - dots[j].x, dots[i].y - dots[j].y);
        if (dist < 120) {
          ctx.beginPath(); ctx.moveTo(dots[i].x, dots[i].y); ctx.lineTo(dots[j].x, dots[j].y);
          ctx.strokeStyle = `rgba(100, 180, 255, ${0.05 * (1 - dist / 120)})`; ctx.lineWidth = 0.5; ctx.stroke();
        }
      }
    }
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const dateStr = now.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    ctx.save();
    ctx.shadowColor = "rgba(100, 180, 255, 0.5)"; ctx.shadowBlur = 20;
    ctx.font = `bold ${Math.min(w * 0.12, 120)}px monospace`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(180, 220, 255, 0.9)";
    ctx.fillText(timeStr, w / 2, h / 2 - 10);
    ctx.restore();
    ctx.font = `300 ${Math.min(w * 0.025, 24)}px sans-serif`;
    ctx.textAlign = "center"; ctx.fillStyle = "rgba(140, 180, 220, 0.5)";
    ctx.fillText(dateStr, w / 2, h / 2 + Math.min(w * 0.07, 60));
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  ctx.fillStyle = "#05050f"; ctx.fillRect(0, 0, w, h); draw();
}

function animateAurora(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const bands = 5;
  const bandData: { baseY: number; hue: number; speed: number; amplitude: number }[] = [];
  for (let i = 0; i < bands; i++) {
    bandData.push({ baseY: h * 0.15 + (h * 0.5 / bands) * i, hue: 120 + i * 30, speed: 0.005 + Math.random() * 0.008, amplitude: 10 + Math.random() * h * 0.1 });
  }
  const stars: { x: number; y: number; r: number; twinkle: number }[] = [];
  for (let i = 0; i < Math.min(150, Math.floor(w / 10)); i++) {
    stars.push({ x: Math.random() * w, y: Math.random() * h * 0.6, r: 0.3 + Math.random() * 1.2, twinkle: Math.random() * Math.PI * 2 });
  }
  let time = 0;
  const draw = () => {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "#020510"); grad.addColorStop(0.5, "#050a18"); grad.addColorStop(1, "#0a1020");
    ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
    for (const s of stars) {
      s.twinkle += 0.02;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(220, 240, 255, ${0.3 + 0.5 * Math.abs(Math.sin(s.twinkle))})`; ctx.fill();
    }
    for (const band of bandData) {
      ctx.beginPath();
      for (let x = 0; x <= w; x += 10) {
        const y = band.baseY + Math.sin(x * 0.003 + time * band.speed) * band.amplitude + Math.sin(x * 0.007 - time * band.speed * 1.3) * band.amplitude * 0.5;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      const bandGrad = ctx.createLinearGradient(0, band.baseY - band.amplitude, 0, band.baseY + band.amplitude * 2);
      bandGrad.addColorStop(0, `hsla(${band.hue}, 80%, 60%, 0)`);
      bandGrad.addColorStop(0.3, `hsla(${band.hue}, 80%, 60%, 0.15)`);
      bandGrad.addColorStop(0.5, `hsla(${band.hue}, 70%, 55%, 0.25)`);
      bandGrad.addColorStop(0.7, `hsla(${band.hue + 20}, 80%, 60%, 0.15)`);
      bandGrad.addColorStop(1, `hsla(${band.hue + 20}, 80%, 60%, 0)`);
      ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
      ctx.fillStyle = bandGrad; ctx.fill();
    }
    time++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateGoldenRatio(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  let angle = 0;
  const draw = () => {
    ctx.fillStyle = "rgba(10, 10, 15, 0.1)"; ctx.fillRect(0, 0, w, h);
    ctx.save(); ctx.translate(w / 2, h / 2); ctx.rotate(angle);
    for (let i = 0; i < 300; i++) {
      const a = i * 137.5 * (Math.PI / 180);
      const r = Math.min(w, h) * 0.002 * Math.sqrt(i) * 10;
      const x = r * Math.cos(a); const y = r * Math.sin(a);
      ctx.beginPath(); ctx.arc(x, y, Math.min(5, Math.sqrt(i) * 0.2), 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${(i + angle * 50) % 360}, 80%, 60%, ${1 - i / 300})`; ctx.fill();
    }
    ctx.restore(); angle += 0.005;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  ctx.fillStyle = "#0a0a0f"; ctx.fillRect(0, 0, w, h); draw();
}

function animateLife(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const res = Math.max(4, Math.floor(w / 80));
  const cols = Math.floor(w / res); const rows = Math.floor(h / res);
  let grid = Array(cols).fill(0).map(() => Array(rows).fill(0).map(() => Math.random() > 0.85 ? 1 : 0));
  let frameCount = 0;
  let inactivity = 0;

  const draw = () => {
    if (frameCount % 4 === 0) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.2)"; ctx.fillRect(0, 0, w, h);
      const next = Array(cols).fill(0).map(() => Array(rows).fill(0));
      let sum = 0;
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          let neighbors = 0;
          for (let x = -1; x <= 1; x++) {
            for (let y = -1; y <= 1; y++) {
              if (x === 0 && y === 0) continue;
              const col = (i + x + cols) % cols; const row = (j + y + rows) % rows;
              neighbors += grid[col][row];
            }
          }
          if (grid[i][j] === 1 && (neighbors < 2 || neighbors > 3)) next[i][j] = 0;
          else if (grid[i][j] === 0 && neighbors === 3) next[i][j] = 1;
          else next[i][j] = grid[i][j];
          
          if (next[i][j] === 1) {
            sum++;
            ctx.fillStyle = `hsla(${(i * j + frameCount) % 360}, 70%, 60%, 0.8)`;
            ctx.fillRect(i * res, j * res, res - 1, res - 1);
          }
        }
      }
      grid = next;
      if (sum < (cols * rows * 0.01)) inactivity++;
      else inactivity = 0;

      if (inactivity > 50 || Math.random() < 0.005) {
        grid = Array(cols).fill(0).map(() => Array(rows).fill(0).map(() => Math.random() > 0.85 ? 1 : 0));
        inactivity = 0;
      } else if (Math.random() < 0.05) {
        grid[Math.floor(Math.random()*cols)][Math.floor(Math.random()*rows)] = 1;
      }
    }
    frameCount++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h); draw();
}

function animateAtoms(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  let time = 0;
  
  // Nucleus setup
  const nucleons: {x:number, y:number, type:number, ox:number, oy:number}[] = [];
  for(let i=0; i<15; i++) {
    nucleons.push({
      x: (Math.random()-0.5)*20, y: (Math.random()-0.5)*20,
      ox: Math.random()*Math.PI*2, oy: Math.random()*Math.PI*2,
      type: Math.random() > 0.5 ? 0 : 1 // proton / neutron
    });
  }
  
  const orbits = [
    {rx: 150, ry: 40, angle: 0, electrons: [0, Math.PI]},
    {rx: 180, ry: 50, angle: Math.PI/3, electrons: [Math.PI/2, Math.PI*1.5]},
    {rx: 210, ry: 60, angle: -Math.PI/3, electrons: [0, Math.PI/3, Math.PI]}
  ];
  
  const draw = () => {
    ctx.fillStyle = "rgba(10, 10, 15, 0.4)"; ctx.fillRect(0, 0, w, h);
    
    ctx.save(); ctx.translate(w/2, h/2);
    const scale = Math.min(w,h) / 500;
    ctx.scale(scale, scale);
    
    // Draw Orbits
    ctx.lineWidth = 1.5;
    for (const o of orbits) {
      ctx.save(); ctx.rotate(o.angle);
      ctx.beginPath(); ctx.ellipse(0, 0, o.rx, o.ry, 0, 0, Math.PI*2);
      ctx.strokeStyle = "rgba(100, 200, 255, 0.15)"; ctx.stroke();
      
      // Draw electrons
      for(let i=0; i<o.electrons.length; i++) {
        o.electrons[i] += 0.05 + i*0.01;
        const ex = Math.cos(o.electrons[i]) * o.rx;
        const ey = Math.sin(o.electrons[i]) * o.ry;
        
        ctx.beginPath(); ctx.arc(ex, ey, 5, 0, Math.PI*2);
        ctx.fillStyle = "#00ffff"; ctx.shadowColor = "#00ffff"; ctx.shadowBlur = 10;
        ctx.fill(); ctx.shadowBlur = 0;
      }
      ctx.restore();
    }
    
    // Draw Nucleus
    for (const n of nucleons) {
      const vx = n.x + Math.sin(time*0.1 + n.ox)*3;
      const vy = n.y + Math.cos(time*0.1 + n.oy)*3;
      ctx.beginPath(); ctx.arc(vx, vy, 8, 0, Math.PI*2);
      ctx.fillStyle = n.type === 0 ? "#ff3333" : "#3333ff";
      ctx.fill();
    }
    
    ctx.restore();
    time++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateGalaxy(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const particles: {x:number, y:number, r:number, theta:number, a:number, s:number, color:string}[] = [];
  const arms = 4;
  const count = Math.min(2000, Math.floor(w*h/300));
  const maxRadius = Math.max(w,h) * 0.6;
  
  for(let i=0; i<count; i++) {
    const arm = i % arms;
    const distance = Math.pow(Math.random(), 2) * maxRadius; // concentrate near center
    const baseAngle = arm * (Math.PI*2/arms);
    const twist = distance * 0.005; 
    const randomOffset = (Math.random() - 0.5) * (Math.random() * 2) * (distance*0.05 + 10);
    
    let hue = 200 + Math.random()*60; // blue to purple
    if (distance < maxRadius*0.2) hue = 30 + Math.random()*30; // yellow core
    
    particles.push({
      x: 0, y: 0,
      r: distance,
      theta: baseAngle + twist,
      a: randomOffset,
      s: Math.random() * 2 + 0.5,
      color: `hsla(${hue}, 80%, 70%, ${Math.random()})`
    });
  }

  let rotation = 0;
  
  const draw = () => {
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(0, 0, 5, 0.2)"; 
    ctx.fillRect(0, 0, w, h);
    
    ctx.save();
    ctx.translate(w/2, h/2);
    ctx.rotate(rotation);
    ctx.scale(1, 0.6); // tilt galaxy
    
    ctx.globalCompositeOperation = "lighter";
    
    // Core glow
    const coreGrad = ctx.createRadialGradient(0,0,0, 0,0,maxRadius*0.2);
    coreGrad.addColorStop(0, "rgba(255, 240, 200, 0.4)");
    coreGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = coreGrad; ctx.fillRect(-maxRadius*0.2, -maxRadius*0.2, maxRadius*0.4, maxRadius*0.4);

    for (const p of particles) {
      // Add a slight swirl over time to inward
      p.theta -= 0.0005 + (0.01 / (p.r/50 + 1)); 
      
      const px = Math.cos(p.theta) * p.r + Math.cos(p.theta + Math.PI/2) * p.a;
      const py = Math.sin(p.theta) * p.r + Math.sin(p.theta + Math.PI/2) * p.a;
      
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(px, py, p.s, 0, Math.PI*2); ctx.fill();
    }
    
    ctx.restore();
    rotation += 0.001;
    
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateSolarSystem(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  let time = 0;
  const baseScale = Math.min(w,h) / 400; 
  const planets = [
    { dist: 40 * baseScale, size: 2 * baseScale, speed: 0.04, color: "#888" },
    { dist: 70 * baseScale, size: 4 * baseScale, speed: 0.03, color: "#eebb88" },
    { dist: 110 * baseScale, size: 5 * baseScale, speed: 0.02, color: "#4488ff" },
    { dist: 150 * baseScale, size: 3 * baseScale, speed: 0.015, color: "#ff4422" },
    { dist: 220 * baseScale, size: 10 * baseScale, speed: 0.008, color: "#ffbb88" },
    { dist: 290 * baseScale, size: 8 * baseScale, speed: 0.006, color: "#ffddaa" }
  ];
  const draw = () => {
    ctx.fillStyle = "rgba(5, 5, 10, 0.3)"; ctx.fillRect(0, 0, w, h);
    ctx.save(); ctx.translate(w/2, h/2);
    
    ctx.beginPath(); ctx.arc(0, 0, 15 * baseScale, 0, Math.PI * 2);
    ctx.fillStyle = "#ffdd00"; ctx.shadowColor = "#ffaa00"; ctx.shadowBlur = 30 * baseScale; ctx.fill(); ctx.shadowBlur = 0;

    for (const p of planets) {
      ctx.beginPath(); ctx.arc(0, 0, p.dist, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.05)"; ctx.stroke();
      const angle = time * p.speed;
      const x = Math.cos(angle) * p.dist; const y = Math.sin(angle) * p.dist;
      ctx.beginPath(); ctx.arc(x, y, Math.max(1, p.size), 0, Math.PI * 2);
      ctx.fillStyle = p.color; ctx.fill();
    }
    ctx.restore(); time++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  ctx.fillStyle = "#05050a"; ctx.fillRect(0, 0, w, h); draw();
}

function animateUzumaki(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  let angleOffset = 0;
  const draw = () => {
    ctx.fillStyle = "rgba(0, 0, 0, 0.1)"; ctx.fillRect(0, 0, w, h);
    ctx.save(); ctx.translate(w/2, h/2);
    ctx.rotate(angleOffset);
    ctx.beginPath();
    const maxRadius = Math.max(w,h);
    let r = 0;
    let angle = 0;
    ctx.moveTo(0,0);
    while (r < maxRadius) {
      r += 0.5;
      angle += 0.1;
      const x = r * Math.cos(angle);
      const y = r * Math.sin(angle);
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `hsl(${(angleOffset*100)%360}, 100%, 50%)`;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
    angleOffset -= 0.05;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h); draw();
}

function animateEditorSkeleton(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const blocks: {x:number, y:number, w:number, h:number}[] = [];
  
  // Sidebar
  blocks.push({x: 20, y: 20, w: w*0.15, h: 15});
  for (let i=0; i<10; i++) {
    blocks.push({x: 20, y: 50 + i*25, w: w*0.1 + Math.random()*w*0.05, h: 10});
  }
  
  // Header
  blocks.push({x: w*0.2, y: 20, w: w*0.3, h: 15});
  
  // Code lines
  const startX = w*0.2;
  let curY = 60;
  while(curY < h - 40) {
    const isIndent = Math.random() > 0.5;
    const indent = isIndent ? 40 : 0;
    blocks.push({x: startX + indent, y: curY, w: Math.random() * w*0.4 + 50, h: 12});
    curY += 24;
    if (Math.random() > 0.8) curY += 12; // gap
  }

  let shimmerPos = -w;
  
  const draw = () => {
    ctx.fillStyle = "#1e1e1e"; ctx.fillRect(0, 0, w, h);
    
    // Draw base blocks
    ctx.fillStyle = "#2d2d2d";
    for (const b of blocks) {
      ctx.beginPath(); ctx.roundRect(b.x, b.y, b.w, b.h, 4); ctx.fill();
    }
    
    // Draw shimmer using composite operation
    ctx.globalCompositeOperation = "source-atop";
    
    shimmerPos += w * 0.015;
    if (shimmerPos > w * 1.5) shimmerPos = -w;
    
    const grad = ctx.createLinearGradient(shimmerPos, 0, shimmerPos + w*0.3, 0);
    grad.addColorStop(0, "rgba(255, 255, 255, 0)");
    grad.addColorStop(0.5, "rgba(255, 255, 255, 0.08)");
    grad.addColorStop(1, "rgba(255, 255, 255, 0)");
    
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    
    ctx.globalCompositeOperation = "source-over";
    
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateSlimes(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const blobs: {x:number, y:number, vx:number, vy:number, r:number}[] = [];
  const numBlobs = 12;
  for (let i = 0; i < numBlobs; i++) {
    blobs.push({
      x: w*0.2 + Math.random()*w*0.6,
      y: h*0.2 + Math.random()*h*0.6,
      vx: (Math.random()-0.5)*3,
      vy: (Math.random()-0.5)*3,
      r: 30 + Math.random()*40
    });
  }

  const getDist = (a: any, b: any) => Math.hypot(b.x - a.x, b.y - a.y);

  // Draws a gooey bridge between two circles if they are close enough
  const drawMetaballBridge = (b1: any, b2: any) => {
    const d = getDist(b1, b2);
    const maxDist = b1.r + b2.r * 2.5;
    if (d > maxDist || d === 0) return;
    
    const angle1 = Math.acos((b1.r*b1.r + d*d - b2.r*b2.r) / (2 * b1.r * d)) || 0;
    const angle2 = Math.acos((b2.r*b2.r + d*d - b1.r*b1.r) / (2 * b2.r * d)) || 0;
    const baseAngle = Math.atan2(b2.y - b1.y, b2.x - b1.x);

    const a1 = baseAngle + angle1 + (Math.PI/4) * (1 - d/maxDist);
    const a2 = baseAngle - angle1 - (Math.PI/4) * (1 - d/maxDist);
    const a3 = baseAngle + Math.PI - angle2 - (Math.PI/4) * (1 - d/maxDist);
    const a4 = baseAngle - Math.PI + angle2 + (Math.PI/4) * (1 - d/maxDist);

    const p1 = {x: b1.x + Math.cos(a1)*b1.r, y: b1.y + Math.sin(a1)*b1.r};
    const p2 = {x: b1.x + Math.cos(a2)*b1.r, y: b1.y + Math.sin(a2)*b1.r};
    const p3 = {x: b2.x + Math.cos(a3)*b2.r, y: b2.y + Math.sin(a3)*b2.r};
    const p4 = {x: b2.x + Math.cos(a4)*b2.r, y: b2.y + Math.sin(a4)*b2.r};

    const c1 = {x: b1.x + (b2.x-b1.x)*0.5, y: b1.y + (b2.y-b1.y)*0.5};

    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.quadraticCurveTo(c1.x, c1.y, p3.x, p3.y);
    ctx.lineTo(p4.x, p4.y);
    ctx.quadraticCurveTo(c1.x, c1.y, p2.x, p2.y);
    ctx.closePath();
    ctx.fill();
  };

  const draw = () => {
    ctx.fillStyle = "#051015"; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "rgba(0, 200, 255, 0.8)";
    
    for (const b of blobs) {
      b.x += b.vx; b.y += b.vy;
      if(b.x < b.r || b.x > w-b.r) b.vx *= -1;
      if(b.y < b.r || b.y > h-b.r) b.vy *= -1;
    }

    ctx.shadowBlur = 15;
    ctx.shadowColor = "#00c8ff";

    for (let i=0; i<numBlobs; i++) {
      ctx.beginPath(); ctx.arc(blobs[i].x, blobs[i].y, blobs[i].r, 0, Math.PI*2); ctx.fill();
      for (let j=i+1; j<numBlobs; j++) {
        drawMetaballBridge(blobs[i], blobs[j]);
      }
    }
    
    ctx.shadowBlur = 0;
    
    // Specular highlight
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    for (const b of blobs) {
      ctx.beginPath(); ctx.arc(b.x - b.r*0.3, b.y - b.r*0.3, b.r*0.2, 0, Math.PI*2); ctx.fill();
    }

    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateFileNames(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const filePaths = [
    "src/main.ts", "package.json", "src/components/App.tsx", 
    "src/styles/main.css", "api/routes.ts", "README.md", 
    "scripts/build.js", ".gitignore", "dist/bundle.js",
    "src/utils/math.ts", "src/hooks/useData.ts", "tests/app.test.ts"
  ];
  
  const texts: {text:string, x:number, y:number, z:number, color:string}[] = [];
  const colors = ["#4ec9b0", "#569cd6", "#ce9178", "#dcdcaa"];
  
  for(let i=0; i<50; i++) {
    texts.push({
      text: filePaths[Math.floor(Math.random()*filePaths.length)],
      x: (Math.random()-0.5) * w * 2,
      y: (Math.random()-0.5) * h * 2,
      z: Math.random() * 1000 + 10,
      color: colors[Math.floor(Math.random()*colors.length)]
    });
  }

  const draw = () => {
    ctx.fillStyle = "rgba(5, 5, 10, 0.3)"; ctx.fillRect(0, 0, w, h);
    
    ctx.save();
    ctx.translate(w/2, h/2);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (const t of texts) {
      t.z -= 5;
      if (t.z <= 1) {
        t.z = 1000;
        t.x = (Math.random()-0.5) * w * 2;
        t.y = (Math.random()-0.5) * h * 2;
        t.text = filePaths[Math.floor(Math.random()*filePaths.length)];
      }

      const scale = 500 / t.z;
      const projX = t.x * scale;
      const projY = t.y * scale;

      const alpha = Math.min(1, Math.max(0, (1000 - t.z) / 500));
      ctx.globalAlpha = alpha;
      
      ctx.font = `${16 * scale}px monospace`;
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, projX, projY);
    }
    
    ctx.restore();
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateProjectStructure(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const nodes: {x:number, y:number, targetX:number, targetY:number, progress:number}[] = [];
  let root = {x: w/2, y: h*0.1};
  let time = 0;
  
  const draw = () => {
    ctx.fillStyle = "rgba(10, 10, 15, 0.1)"; ctx.fillRect(0, 0, w, h);
    
    if (time % 60 === 0 && nodes.length < 50) {
      let parent = nodes.length > 0 ? nodes[Math.floor(Math.random() * nodes.length)] : { targetX: root.x, targetY: root.y };
      nodes.push({
        x: parent.targetX, y: parent.targetY,
        targetX: parent.targetX + (Math.random() - 0.5) * w * 0.3,
        targetY: parent.targetY + h * 0.1,
        progress: 0
      });
    }

    ctx.strokeStyle = "rgba(100, 255, 150, 0.5)";
    ctx.lineWidth = 2;
    for (const n of nodes) {
      if (n.progress < 1) n.progress += 0.02;
      const curX = n.x + (n.targetX - n.x) * n.progress;
      const curY = n.y + (n.targetY - n.y) * n.progress;
      ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(curX, curY); ctx.stroke();
      ctx.beginPath(); ctx.arc(curX, curY, 3, 0, Math.PI*2); ctx.fillStyle="#fff"; ctx.fill();
    }
    time++;
    if (time > 600) { nodes.length = 0; time = 0; ctx.fillStyle="#0a0a0f"; ctx.fillRect(0,0,w,h); }
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  ctx.fillStyle = "#0a0a0f"; ctx.fillRect(0, 0, w, h); draw();
}

function animateCosmos(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  let time = 0;
  const draw = () => {
    // slow animated gradient background to simulate nebula
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, `hsla(${(time*0.1)%360}, 50%, 10%, 0.1)`);
    g.addColorStop(0.5, `hsla(${(time*0.1+60)%360}, 40%, 5%, 0.1)`);
    g.addColorStop(1, `hsla(${(time*0.1+120)%360}, 50%, 10%, 0.1)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    
    // some slow floating stars
    if (Math.random() < 0.2) {
      ctx.fillStyle = `rgba(255,255,255,${Math.random()})`;
      ctx.fillRect(Math.random()*w, Math.random()*h, Math.random()*2, Math.random()*2);
    }
    time++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h); draw();
}

function animateBlackHole(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  let time = 0;
  const radius = Math.min(w,h) * 0.12;
  const diskInner = radius * 1.5;
  const diskOuter = radius * 4;
  
  const draw = () => {
    ctx.fillStyle = "#020202"; ctx.fillRect(0, 0, w, h);
    ctx.save(); ctx.translate(w/2, h/2);
    
    // Tilt the disk
    ctx.rotate(-0.2);
    
    // Lensing Halo (behind/top-bottom)
    const haloGrad = ctx.createRadialGradient(0, 0, radius, 0, 0, diskOuter * 1.5);
    haloGrad.addColorStop(0, "rgba(255, 150, 50, 0)");
    haloGrad.addColorStop(0.1, "rgba(255, 100, 30, 0.5)");
    haloGrad.addColorStop(0.3, "rgba(100, 50, 255, 0.1)");
    haloGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
    
    ctx.save();
    // Squish vertically to simulate the wrapped visual
    ctx.scale(1, 1.2);
    ctx.fillStyle = haloGrad;
    ctx.beginPath(); ctx.arc(0, 0, diskOuter * 1.5, 0, Math.PI*2); ctx.fill();
    ctx.restore();

    // Back half of the disk
    ctx.save();
    ctx.scale(1, 0.15); // very flat
    ctx.beginPath();
    ctx.arc(0, 0, diskOuter, Math.PI, Math.PI*2);
    ctx.lineTo(diskInner, 0);
    ctx.arc(0, 0, diskInner, Math.PI*2, Math.PI, true);
    ctx.closePath();
    
    const backGrad = ctx.createRadialGradient(0, 0, diskInner, 0, 0, diskOuter);
    backGrad.addColorStop(0, "rgba(255, 200, 100, 0.9)");
    backGrad.addColorStop(0.5, "rgba(255, 100, 50, 0.6)");
    backGrad.addColorStop(1, "rgba(20, 10, 50, 0)");
    ctx.fillStyle = backGrad;
    ctx.fill();
    ctx.restore();

    // The Black Hole itself
    ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI*2);
    ctx.fillStyle = "#000"; 
    ctx.shadowColor = "rgba(255, 100, 30, 0.8)"; ctx.shadowBlur = radius * 0.3;
    ctx.fill(); ctx.shadowBlur = 0;

    // Front half of the disk
    ctx.save();
    ctx.scale(1, 0.15);
    ctx.beginPath();
    ctx.arc(0, 0, diskOuter, 0, Math.PI);
    ctx.lineTo(-diskInner, 0);
    ctx.arc(0, 0, diskInner, Math.PI, 0, true);
    ctx.closePath();
    
    const frontGrad = ctx.createRadialGradient(0, 0, diskInner, 0, 0, diskOuter);
    frontGrad.addColorStop(0, "rgba(255, 220, 150, 1)");
    frontGrad.addColorStop(0.3, "rgba(255, 120, 40, 0.8)");
    frontGrad.addColorStop(0.8, "rgba(50, 20, 100, 0.2)");
    frontGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = frontGrad;
    ctx.fill();
    
    // Doppler shifting (right side brighter/bluer, left side redder/dimmer)
    const doppler = ctx.createLinearGradient(-diskOuter, 0, diskOuter, 0);
    doppler.addColorStop(0, "rgba(255, 0, 0, 0.2)"); // receding
    doppler.addColorStop(1, "rgba(100, 200, 255, 0.3)"); // approaching
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = doppler;
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";

    // Animated particles in the disk
    for(let i=0; i<150; i++) {
      const a = (time * 0.05 + i * 0.1) % (Math.PI);
      const d = diskInner + ((i * 137.5) % (diskOuter - diskInner));
      const x = Math.cos(a) * d;
      const y = Math.sin(a) * d;
      ctx.fillStyle = `rgba(255, 255, 255, ${Math.random()*0.5})`;
      ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI*2); ctx.fill();
    }
    
    ctx.restore();
    ctx.restore();
    
    time++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateForest(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  let cameraX = 0;
  
  // Deterministic random
  const hash = (n: number) => {
    let m = Math.sin(n) * 10000;
    return m - Math.floor(m);
  };

  const drawTree = (cx: number, cy: number, size: number, color: string, seed: number) => {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.rect(cx - size*0.1, cy - size, size*0.2, size); ctx.fill();
    const type = Math.floor(hash(seed)*3);
    if(type === 0) {
      for (let i=0; i<3; i++) {
        ctx.beginPath();
        ctx.moveTo(cx, cy - size - size*i*0.4);
        ctx.lineTo(cx + size*(1 - i*0.2), cy - size*0.3 - size*i*0.3);
        ctx.lineTo(cx - size*(1 - i*0.2), cy - size*0.3 - size*i*0.3);
        ctx.fill();
      }
    } else if (type === 1) {
      ctx.beginPath();
      ctx.ellipse(cx, cy - size*0.8, size*0.6, size*0.8, 0, 0, Math.PI*2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy - size*0.6, size*0.5, 0, Math.PI*2);
      ctx.arc(cx - size*0.3, cy - size*0.9, size*0.4, 0, Math.PI*2);
      ctx.arc(cx + size*0.3, cy - size*0.9, size*0.4, 0, Math.PI*2);
      ctx.fill();
    }
  };
  
  const layers = [
    { speed: 0.2, size: 30, color: "#051510", spacing: 80 },
    { speed: 0.6, size: 60, color: "#0a2a20", spacing: 140 },
    { speed: 1.5, size: 120, color: "#104030", spacing: 250 }
  ];

  const draw = () => {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "#020a15"); grad.addColorStop(1, "#1a3a30");
    ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
    
    // Moon
    ctx.fillStyle = "rgba(255, 255, 230, 0.8)";
    ctx.beginPath(); ctx.arc(w*0.8, h*0.2, Math.min(w,h)*0.08, 0, Math.PI*2); ctx.fill();
    
    cameraX += 2;
    
    for (let lIndex=0; lIndex<layers.length; lIndex++) {
      const l = layers[lIndex];
      const layerCam = cameraX * l.speed;
      const startIndex = Math.floor(layerCam / l.spacing) - 1;
      const endIndex = Math.floor((layerCam + w) / l.spacing) + 1;
      
      for (let i = startIndex; i <= endIndex; i++) {
        const seed = lIndex * 1000 + i;
        const x = i * l.spacing + hash(seed)*l.spacing*0.5 - layerCam;
        const size = l.size + hash(seed+1)*l.size*0.4;
        drawTree(x, h, size, l.color, seed);
      }
    }
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateChatting(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const messages = [
    "Hello, how are you?", "I'm doing great, thanks!", "Did you check the PR?", 
    "Yeah, looks good to me.", "Let's deploy to production.", "Wait, the build failed!", 
    "I'll take a look at the logs.", "Found the bug, it was a typo.", "Classic. Ship it.", 
    "LGTM 🚀", "Can we schedule a meeting?", "Sure, let's do 3 PM.", "Awesome.",
    "Did you see the new design?", "Yes, it looks amazing!", "Great work team!"
  ];
  
  const bubbles: {isLeft: boolean, y: number, text: string, bw: number, bh: number, targetY: number, alpha: number}[] = [];
  let time = 0;

  const draw = () => {
    ctx.fillStyle = "#111"; ctx.fillRect(0, 0, w, h);
    
    if (time % 100 === 0) {
      const isLeft = Math.random() > 0.5;
      const text = messages[Math.floor(Math.random() * messages.length)];
      ctx.font = `14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      const metrics = ctx.measureText(text);
      const bw = metrics.width + 30;
      const bh = 40;
      
      bubbles.forEach(b => b.targetY -= (bh + 15));
      bubbles.push({ isLeft, y: h + 50, targetY: h - bh - 20, text, bw, bh, alpha: 0 });
    }
    
    for (let i=bubbles.length-1; i>=0; i--) {
      const b = bubbles[i];
      b.y += (b.targetY - b.y) * 0.1;
      b.alpha = Math.min(1, b.alpha + 0.05);
      const x = b.isLeft ? 20 : w - b.bw - 20;
      
      ctx.fillStyle = b.isLeft ? `rgba(60, 60, 60, ${b.alpha})` : `rgba(0, 120, 212, ${b.alpha})`;
      ctx.beginPath(); ctx.roundRect(x, b.y, b.bw, b.bh, 12); ctx.fill();
      
      ctx.beginPath();
      if (b.isLeft) {
        ctx.moveTo(x + 15, b.y + b.bh); ctx.lineTo(x + 5, b.y + b.bh + 10); ctx.lineTo(x + 25, b.y + b.bh - 2);
      } else {
        ctx.moveTo(x + b.bw - 15, b.y + b.bh); ctx.lineTo(x + b.bw - 5, b.y + b.bh + 10); ctx.lineTo(x + b.bw - 25, b.y + b.bh - 2);
      }
      ctx.fill();
      
      ctx.fillStyle = `rgba(255, 255, 255, ${b.alpha})`;
      ctx.font = `14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      ctx.fillText(b.text, x + 15, b.y + 25);
      
      if (b.y < -100) bubbles.splice(i, 1);
    }
    
    time++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateCodeMinimap(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const colors = {
    keyword: "#569cd6", function: "#dcdcaa", string: "#ce9178", 
    comment: "#6a9955", variable: "#9cdcfe", control: "#c586c0", text: "#d4d4d4"
  };
  const lineTypes = [
    [{c: colors.keyword, w: 20}, {c: colors.function, w: 30}, {c: colors.text, w: 10}], // func def
    [{c: colors.text, w: 15}, {c: colors.variable, w: 20}, {c: colors.text, w: 5}, {c: colors.string, w: 40}], // var assign
    [{c: colors.control, w: 15}, {c: colors.text, w: 5}, {c: colors.variable, w: 15}, {c: colors.text, w: 10}], // if stmt
    [{c: colors.function, w: 25}, {c: colors.text, w: 5}, {c: colors.variable, w: 30}, {c: colors.text, w: 5}], // func call
    [{c: colors.comment, w: 80}], // comment
    [{c: colors.text, w: 5}] // bracket
  ];

  const doc: {indent:number, tokens:{c:string, w:number}[]}[] = [];
  let indent = 0;
  for(let i=0; i<200; i++) {
    const type = Math.floor(Math.random() * lineTypes.length);
    if (type === 2 || type === 0) { // block start
      doc.push({indent, tokens: lineTypes[type]});
      indent += 10;
    } else if (type === 5 && indent > 0) { // bracket close
      indent -= 10;
      doc.push({indent, tokens: lineTypes[type]});
    } else {
      doc.push({indent, tokens: lineTypes[type]});
    }
  }

  let scrollY = 0;
  const draw = () => {
    ctx.fillStyle = "#1e1e1e"; ctx.fillRect(0, 0, w, h);
    
    scrollY += 1.5;
    if (scrollY > doc.length * 6) scrollY = 0;

    const scale = Math.min(2, w / 100);
    ctx.save();
    ctx.translate(w/2 - 50*scale, -scrollY + h*0.2); // center horizontally
    ctx.scale(scale, scale);
    
    // Draw visible portion
    const startIdx = Math.max(0, Math.floor(scrollY/6) - 20);
    const endIdx = Math.min(doc.length, startIdx + Math.ceil(h/(6*scale)) + 40);

    for (let i=startIdx; i<endIdx; i++) {
      const line = doc[i];
      let x = line.indent;
      for (const t of line.tokens) {
        ctx.fillStyle = t.c;
        ctx.fillRect(x, i*6, t.w, 3);
        x += t.w + 3;
      }
    }
    
    // Loop seam
    if (endIdx === doc.length) {
      for (let i=0; i<20; i++) {
        const line = doc[i];
        let x = line.indent;
        for (const t of line.tokens) {
          ctx.fillStyle = t.c;
          ctx.fillRect(x, (doc.length + i)*6, t.w, 3);
          x += t.w + 3;
        }
      }
    }

    ctx.restore();
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateSingleEye(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  let blink = 1;
  let targetBlink = 1;
  let lookX = 0;
  let lookY = 0;
  let targetLookX = 0;
  let targetLookY = 0;
  let dilation = 0.4;
  let targetDilation = 0.4;

  const draw = () => {
    ctx.fillStyle = "#0a0a0a"; ctx.fillRect(0, 0, w, h);
    const r = Math.min(w, h) * 0.3;
    
    if (Math.random() < 0.02) targetBlink = 0.05; // blink
    else if (Math.random() < 0.1) targetBlink = 1;
    
    if (Math.random() < 0.05) {
      targetLookX = (Math.random() - 0.5) * 2;
      targetLookY = (Math.random() - 0.5) * 2;
      targetDilation = 0.3 + Math.random() * 0.4;
    }

    blink += (targetBlink - blink) * 0.2;
    lookX += (targetLookX - lookX) * 0.1;
    lookY += (targetLookY - lookY) * 0.1;
    dilation += (targetDilation - dilation) * 0.05;
    
    ctx.save(); ctx.translate(w/2, h/2);
    
    // Outer lid shadow
    ctx.beginPath(); ctx.ellipse(0, 0, r*1.1, r*1.1 * blink, 0, 0, Math.PI*2);
    ctx.fillStyle = "rgba(255,255,255,0.05)"; ctx.shadowBlur = 30; ctx.shadowColor="#fff"; ctx.fill(); ctx.shadowBlur=0;
    
    // Sclera
    ctx.beginPath(); ctx.ellipse(0, 0, r, r * blink, 0, 0, Math.PI*2);
    ctx.fillStyle = "#f4f4f4"; ctx.fill();
    
    // Clip to sclera
    ctx.clip();
    
    const pupilX = lookX * r * 0.3;
    const pupilY = lookY * r * 0.3;
    
    // Iris
    ctx.beginPath(); ctx.arc(pupilX, pupilY, r*0.45, 0, Math.PI*2);
    const irisGrad = ctx.createRadialGradient(pupilX, pupilY, r*0.1, pupilX, pupilY, r*0.45);
    irisGrad.addColorStop(0, "#44ccff");
    irisGrad.addColorStop(0.8, "#0055aa");
    irisGrad.addColorStop(1, "#001133");
    ctx.fillStyle = irisGrad; ctx.fill();
    
    // Iris details (lines)
    ctx.lineWidth = 1;
    for (let i=0; i<60; i++) {
      ctx.beginPath();
      ctx.moveTo(pupilX + Math.cos(i/60*Math.PI*2)*r*0.2, pupilY + Math.sin(i/60*Math.PI*2)*r*0.2);
      ctx.lineTo(pupilX + Math.cos(i/60*Math.PI*2)*r*0.45, pupilY + Math.sin(i/60*Math.PI*2)*r*0.45);
      ctx.strokeStyle = `rgba(255,255,255,${Math.random()*0.3})`;
      ctx.stroke();
    }
    
    // Pupil
    ctx.beginPath(); ctx.arc(pupilX, pupilY, r*0.45 * dilation, 0, Math.PI*2);
    ctx.fillStyle = "#050505"; ctx.fill();
    
    // Eye shine
    ctx.beginPath(); ctx.arc(pupilX - r*0.15, pupilY - r*0.15, r*0.08, 0, Math.PI*2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.8)"; ctx.fill();
    ctx.beginPath(); ctx.arc(pupilX + r*0.1, pupilY + r*0.05, r*0.03, 0, Math.PI*2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.5)"; ctx.fill();
    
    ctx.restore();
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateThreeBody(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const G = 2; // Gravitational constant
  const bodies = [
    { x: w/2 - 50, y: h/2, vx: 0, vy: 1.5, mass: 200, color: "#ff5555" },
    { x: w/2 + 50, y: h/2, vx: 0, vy: -1.5, mass: 200, color: "#55ff55" },
    { x: w/2, y: h/2 + 86, vx: -1.5, vy: 0, mass: 200, color: "#5555ff" }
  ];
  
  const draw = () => {
    ctx.fillStyle = "rgba(0, 0, 5, 0.05)"; ctx.fillRect(0, 0, w, h);
    
    // Physics step
    for (let i=0; i<bodies.length; i++) {
      for (let j=i+1; j<bodies.length; j++) {
        const dx = bodies[j].x - bodies[i].x;
        const dy = bodies[j].y - bodies[i].y;
        const distSq = Math.max(dx*dx + dy*dy, 100);
        const force = (G * bodies[i].mass * bodies[j].mass) / distSq;
        const dist = Math.sqrt(distSq);
        const fx = force * dx / dist;
        const fy = force * dy / dist;
        bodies[i].vx += fx / bodies[i].mass; bodies[i].vy += fy / bodies[i].mass;
        bodies[j].vx -= fx / bodies[j].mass; bodies[j].vy -= fy / bodies[j].mass;
      }
    }
    
    // Bounds and drawing
    for (const b of bodies) {
      b.x += b.vx; b.y += b.vy;
      // Soft bounds
      if (b.x < 0 || b.x > w) b.vx *= -0.5;
      if (b.y < 0 || b.y > h) b.vy *= -0.5;
      
      ctx.beginPath(); ctx.arc(b.x, b.y, 4, 0, Math.PI*2);
      ctx.fillStyle = b.color;
      ctx.shadowColor = b.color; ctx.shadowBlur = 10;
      ctx.fill(); ctx.shadowBlur = 0;
    }
    
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  ctx.fillStyle = "#000005"; ctx.fillRect(0, 0, w, h); draw();
}

function animateNeurons(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const nodes: {x:number, y:number, vx:number, vy:number}[] = [];
  const count = Math.min(80, Math.floor(w*h/3000));
  for (let i=0; i<count; i++) {
    nodes.push({ 
      x: Math.random()*w, y: Math.random()*h, 
      vx: (Math.random()-0.5)*0.5, vy: (Math.random()-0.5)*0.5 
    });
  }
  const signals: {a:number, b:number, progress:number, speed:number}[] = [];
  
  const draw = () => {
    ctx.fillStyle = "rgba(5, 10, 15, 0.3)"; ctx.fillRect(0, 0, w, h);
    
    // Update nodes
    for(const n of nodes) {
      n.x += n.vx; n.y += n.vy;
      if(n.x < 0 || n.x > w) n.vx *= -1;
      if(n.y < 0 || n.y > h) n.vy *= -1;
    }
    
    const maxDist = 150;
    
    // Draw connections
    for (let i=0; i<count; i++) {
      for (let j=i+1; j<count; j++) {
        const dist = Math.hypot(nodes[i].x-nodes[j].x, nodes[i].y-nodes[j].y);
        if (dist < maxDist) {
          ctx.beginPath(); ctx.moveTo(nodes[i].x, nodes[i].y); ctx.lineTo(nodes[j].x, nodes[j].y);
          ctx.strokeStyle = `rgba(100, 200, 255, ${0.15 * (1 - dist/maxDist)})`;
          ctx.lineWidth = 1;
          ctx.stroke();
          
          if(Math.random() < 0.0005) {
            signals.push({ a: i, b: j, progress: 0, speed: 0.01 + Math.random()*0.02 });
          }
        }
      }
      ctx.beginPath(); ctx.arc(nodes[i].x, nodes[i].y, 2, 0, Math.PI*2);
      ctx.fillStyle = "rgba(100, 200, 255, 0.5)"; ctx.fill();
    }
    
    // Update and draw signals
    for (let i=signals.length-1; i>=0; i--) {
      const s = signals[i];
      s.progress += s.speed;
      if (s.progress >= 1) {
        signals.splice(i, 1);
        continue;
      }
      const x = nodes[s.a].x + (nodes[s.b].x - nodes[s.a].x) * s.progress;
      const y = nodes[s.a].y + (nodes[s.b].y - nodes[s.a].y) * s.progress;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI*2);
      ctx.fillStyle = "#ffffff"; ctx.shadowColor = "#00aaff"; ctx.shadowBlur = 10; ctx.fill(); ctx.shadowBlur = 0;
    }
    
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  ctx.fillStyle = "#050a0f"; ctx.fillRect(0, 0, w, h); draw();
}

function animateDimensionalTravel(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const lines: {angle:number, speed:number}[] = [];
  for (let i=0; i<30; i++) {
    lines.push({ angle: (i/30)*Math.PI*2, speed: 0 });
  }
  let zOffset = 0;
  
  const draw = () => {
    ctx.fillStyle = "rgba(0, 0, 0, 0.15)"; ctx.fillRect(0, 0, w, h);
    ctx.save(); ctx.translate(w/2, h/2);
    
    // Radial warp lines
    ctx.beginPath();
    for (const l of lines) {
      l.angle += 0.005;
      const x = Math.cos(l.angle) * w;
      const y = Math.sin(l.angle) * w;
      ctx.moveTo(0,0); ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(100, 50, 255, 0.2)"; ctx.stroke();
    
    // Z grid squares expanding
    zOffset = (zOffset + 2) % 50;
    for (let i=0; i<10; i++) {
      const size = Math.pow(1.5, i) * 5 + zOffset;
      if (size > w) continue;
      ctx.beginPath(); ctx.rect(-size/2, -size/2, size, size);
      ctx.strokeStyle = `rgba(0, 255, 255, ${0.5 - size/w})`;
      ctx.stroke();
    }
    
    ctx.restore();
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h); draw();
}

function animateEyes(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const eyes: {x:number, y:number, r:number, blink:number, targetBlink:number, lookX:number, lookY:number}[] = [];
  for (let i=0; i<10; i++) {
    eyes.push({
      x: w*0.1 + Math.random()*w*0.8,
      y: h*0.1 + Math.random()*h*0.8,
      r: 10 + Math.random()*20,
      blink: 1, targetBlink: 1,
      lookX: 0, lookY: 0
    });
  }
  
  let targetLookX = 0;
  let targetLookY = 0;
  
  const draw = () => {
    ctx.fillStyle = "rgba(10, 10, 10, 0.3)"; ctx.fillRect(0, 0, w, h);
    
    if (Math.random() < 0.05) {
      targetLookX = (Math.random() - 0.5) * 10;
      targetLookY = (Math.random() - 0.5) * 10;
    }
    
    for (const e of eyes) {
      if (Math.random() < 0.01) e.targetBlink = 0.1; // blink
      else if (Math.random() < 0.1) e.targetBlink = 1; // open
      
      e.blink += (e.targetBlink - e.blink) * 0.2;
      e.lookX += (targetLookX - e.lookX) * 0.1;
      e.lookY += (targetLookY - e.lookY) * 0.1;
      
      // Sclera
      ctx.beginPath(); ctx.ellipse(e.x, e.y, e.r, e.r * e.blink, 0, 0, Math.PI*2);
      ctx.fillStyle = "#fff"; ctx.fill();
      
      if (e.blink > 0.2) {
        // Iris
        ctx.beginPath(); ctx.arc(e.x + e.lookX*(e.r/15), e.y + e.lookY*(e.r/15), e.r*0.4, 0, Math.PI*2);
        ctx.fillStyle = "#3399ff"; ctx.fill();
        // Pupil
        ctx.beginPath(); ctx.arc(e.x + e.lookX*(e.r/15), e.y + e.lookY*(e.r/15), e.r*0.2, 0, Math.PI*2);
        ctx.fillStyle = "#000"; ctx.fill();
      }
    }
    
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  ctx.fillStyle = "#0a0a0a"; ctx.fillRect(0, 0, w, h); draw();
}

function animateFace(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  let time = 0;
  let expression = 0; // 0 = neutral, 1 = happy, 2 = sad, 3 = speaking
  let targetExpression = 0;
  let speakingMouth = 0;
  
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let dataArray: Uint8Array | null = null;
  let streamRef: MediaStream | null = null;

  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    streamRef = stream;
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);
    analyser.fftSize = 256;
    dataArray = new Uint8Array(analyser.frequencyBinCount);
  }).catch(() => {});

  const draw = () => {
    if (!isActive()) {
      if (streamRef) streamRef.getTracks().forEach(t => t.stop());
      if (audioCtx) audioCtx.close();
      return;
    }

    ctx.fillStyle = "rgba(10, 10, 12, 0.4)"; ctx.fillRect(0, 0, w, h);
    
    let volume = 0;
    if (analyser && dataArray) {
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for(let i=0; i<dataArray.length; i++) sum += dataArray[i];
      volume = sum / dataArray.length;
    }

    if (volume > 10) {
      targetExpression = 3;
      speakingMouth = (volume / 255) * 40;
    } else {
      if (Math.random() < 0.01) targetExpression = Math.floor(Math.random() * 3);
      expression += (targetExpression - expression) * 0.1;
      speakingMouth += (0 - speakingMouth) * 0.2;
    }

    ctx.save(); ctx.translate(w/2, h/2);
    const size = Math.min(w,h) * 0.4;
    
    // Face glow
    const g = ctx.createRadialGradient(0,0,size*0.5,0,0,size*1.5);
    g.addColorStop(0, "rgba(0, 255, 150, 0.1)");
    g.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = g; ctx.fillRect(-size*2,-size*2,size*4,size*4);

    ctx.strokeStyle = "#00ff96"; ctx.lineWidth = 4; ctx.lineCap = "round"; ctx.lineJoin = "round";
    
    // Left Eye
    ctx.beginPath();
    if (targetExpression === 1) { // happy
      ctx.moveTo(-size*0.4, -size*0.1); ctx.quadraticCurveTo(-size*0.25, -size*0.3, -size*0.1, -size*0.1);
    } else if (targetExpression === 2) { // sad
      ctx.moveTo(-size*0.4, -size*0.2); ctx.lineTo(-size*0.1, -size*0.1);
    } else {
      ctx.moveTo(-size*0.4, -size*0.2); ctx.lineTo(-size*0.1, -size*0.2);
    }
    ctx.stroke();

    // Right Eye
    ctx.beginPath();
    if (targetExpression === 1) { // happy
      ctx.moveTo(size*0.1, -size*0.1); ctx.quadraticCurveTo(size*0.25, -size*0.3, size*0.4, -size*0.1);
    } else if (targetExpression === 2) { // sad
      ctx.moveTo(size*0.1, -size*0.1); ctx.lineTo(size*0.4, -size*0.2);
    } else {
      ctx.moveTo(size*0.1, -size*0.2); ctx.lineTo(size*0.4, -size*0.2);
    }
    ctx.stroke();

    // Mouth
    ctx.beginPath();
    if (targetExpression === 3) {
      ctx.ellipse(0, size*0.3, size*0.2, 5 + speakingMouth, 0, 0, Math.PI*2);
    } else if (targetExpression === 1) {
      ctx.moveTo(-size*0.2, size*0.2); ctx.quadraticCurveTo(0, size*0.4, size*0.2, size*0.2);
    } else if (targetExpression === 2) {
      ctx.moveTo(-size*0.2, size*0.4); ctx.quadraticCurveTo(0, size*0.2, size*0.2, size*0.4);
    } else {
      ctx.moveTo(-size*0.2, size*0.3); ctx.lineTo(size*0.2, size*0.3);
    }
    ctx.stroke();
    
    ctx.fillStyle = "rgba(0, 255, 150, 0.05)";
    for(let i=0; i<size*2; i+=10) {
      ctx.fillRect(-size*0.8, -size + i + (time%10), size*1.6, 2);
    }

    ctx.restore();
    time++;
    setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateAi(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  let time = 0;
  const dataStreams: {angle:number, dist:number, speed:number, text:string}[] = [];
  for(let i=0; i<40; i++) {
    dataStreams.push({
      angle: Math.random()*Math.PI*2, dist: w,
      speed: 2 + Math.random()*5,
      text: Math.random() > 0.5 ? "1" : "0"
    });
  }

  const draw = () => {
    ctx.fillStyle = "rgba(5, 5, 10, 0.3)"; ctx.fillRect(0, 0, w, h);
    ctx.save(); ctx.translate(w/2, h/2);
    
    const coreRadius = Math.min(w,h) * 0.15;
    
    // Streams
    ctx.font = "12px monospace";
    for(const d of dataStreams) {
      d.dist -= d.speed;
      if (d.dist < coreRadius) {
        d.dist = w*0.8;
        d.angle = Math.random()*Math.PI*2;
        d.text = Math.random() > 0.5 ? "1" : "0";
      }
      const x = Math.cos(d.angle) * d.dist;
      const y = Math.sin(d.angle) * d.dist;
      ctx.fillStyle = `rgba(0, 255, 200, ${1 - d.dist/(w*0.8)})`;
      ctx.fillText(d.text, x, y);
    }
    
    // Core waves
    ctx.shadowColor = "#00ffcc"; ctx.shadowBlur = 30;
    ctx.strokeStyle = "#00ffcc"; ctx.lineWidth = 3;
    
    for (let j=0; j<3; j++) {
      ctx.beginPath();
      for (let i=0; i<=Math.PI*2; i+=0.1) {
        const rad = coreRadius + Math.sin(i*5 + time*0.05 + j)*15 + Math.cos(i*3 - time*0.03)*10;
        const x = Math.cos(i) * rad;
        const y = Math.sin(i) * rad;
        if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.closePath(); ctx.stroke();
    }
    ctx.shadowBlur = 0;
    
    // Core center
    const g = ctx.createRadialGradient(0,0,0, 0,0,coreRadius);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.2, "rgba(0, 255, 200, 0.8)");
    g.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0,0,coreRadius,0,Math.PI*2); ctx.fill();

    ctx.restore();
    time++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}


function animateApiRequest(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const requests: {x:number, y:number, targetX:number, targetY:number, progress:number, speed:number, text:string, color:string}[] = [];
  const methods = [
    {t: "GET /users", c: "#569cd6"}, {t: "POST /auth", c: "#4ec9b0"}, 
    {t: "200 OK", c: "#6a9955"}, {t: "404 NOT FOUND", c: "#ce9178"},
    {t: "GET /api/data", c: "#569cd6"}, {t: "500 ERROR", c: "#f44336"}
  ];
  
  let time = 0;
  const draw = () => {
    ctx.fillStyle = "rgba(10, 15, 20, 0.3)"; ctx.fillRect(0, 0, w, h);
    
    const clientX = w * 0.2; const clientY = h * 0.5;
    const serverX = w * 0.8; const serverY = h * 0.5;
    
    // Nodes
    ctx.beginPath(); ctx.arc(clientX, clientY, 40, 0, Math.PI*2);
    ctx.fillStyle = "#1e1e1e"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#4ec9b0"; ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.textAlign="center"; ctx.font="14px monospace"; ctx.fillText("CLIENT", clientX, clientY+4);
    
    ctx.beginPath(); ctx.arc(serverX, serverY, 50, 0, Math.PI*2);
    ctx.fillStyle = "#1e1e1e"; ctx.fill(); ctx.strokeStyle = "#569cd6"; ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.fillText("SERVER", serverX, serverY+4);

    // Connection line
    ctx.beginPath(); ctx.moveTo(clientX+40, clientY); ctx.lineTo(serverX-50, serverY);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.1)"; ctx.stroke();

    if (time % 20 === 0) {
      const isReq = Math.random() > 0.5;
      const m = methods[Math.floor(Math.random()*methods.length)];
      requests.push({
        x: isReq ? clientX+40 : serverX-50, y: isReq ? clientY : serverY,
        targetX: isReq ? serverX-50 : clientX+40, targetY: isReq ? serverY : clientY,
        progress: 0, speed: 0.01 + Math.random()*0.015, text: m.t, color: m.c
      });
    }

    for (let i=requests.length-1; i>=0; i--) {
      const r = requests[i];
      r.progress += r.speed;
      const px = r.x + (r.targetX - r.x) * r.progress;
      const py = r.y + (r.targetY - r.y) * r.progress + Math.sin(r.progress*Math.PI)*50 * (r.x < r.targetX ? 1 : -1);
      
      ctx.fillStyle = r.color;
      ctx.beginPath(); ctx.roundRect(px - 10, py - 10, Math.max(80, ctx.measureText(r.text).width+20), 20, 4); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.fillText(r.text, px - 10 + 40, py + 4);
      
      if (r.progress >= 1) requests.splice(i, 1);
    }
    
    time++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateEarth(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const points: {x:number, y:number, z:number, lat:number, lon:number}[] = [];
  const radius = Math.min(w,h)*0.3;
  
  // Create sphere points (fibonacci spiral for even distribution)
  const samples = 400;
  const phi = Math.PI * (3 - Math.sqrt(5)); 
  for (let i = 0; i < samples; i++) {
    const y = 1 - (i / (samples - 1)) * 2; 
    const r = Math.sqrt(1 - y * y);
    const theta = phi * i;
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    points.push({x: x*radius, y: y*radius, z: z*radius, lat: 0, lon: 0});
  }
  
  let angle = 0;
  
  const draw = () => {
    ctx.fillStyle = "rgba(5, 10, 15, 0.4)"; ctx.fillRect(0, 0, w, h);
    ctx.save(); ctx.translate(w/2, h/2);
    
    angle -= 0.005;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    
    // Tilt the earth a bit
    const tilt = 0.4;
    const cosT = Math.cos(tilt);
    const sinT = Math.sin(tilt);

    for (const p of points) {
      // rotate Y
      let rx = p.x * cosA - p.z * sinA;
      let rz = p.x * sinA + p.z * cosA;
      let ry = p.y;
      
      // tilt Z
      const tx = rx;
      const ty = ry * cosT - rz * sinT;
      const tz = ry * sinT + rz * cosT;
      
      // only draw front half
      if (tz > 0) {
        ctx.beginPath(); ctx.arc(tx, ty, 1.5 + (tz/radius), 0, Math.PI*2);
        ctx.fillStyle = `rgba(100, 200, 255, ${0.3 + (tz/radius)*0.7})`;
        ctx.fill();
      }
    }
    
    // Glow
    ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI*2);
    ctx.strokeStyle = "rgba(100, 200, 255, 0.2)"; ctx.lineWidth = 2; ctx.stroke();
    
    ctx.restore();
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateMinecraft(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const blockSize = Math.max(10, Math.floor(Math.min(w,h)/30));
  const cols = Math.floor(w / blockSize) + 4;
  const rows = Math.floor(h / blockSize) + 4;
  let time = 0;
  
  const drawBlock = (sx:number, sy:number, colorTop:string, colorLeft:string, colorRight:string) => {
    const hw = blockSize; const hh = blockSize*0.5;
    // Top
    ctx.fillStyle = colorTop;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx+hw, sy-hh); ctx.lineTo(sx+hw*2, sy); ctx.lineTo(sx+hw, sy+hh); ctx.fill();
    // Left
    ctx.fillStyle = colorLeft;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx+hw, sy+hh); ctx.lineTo(sx+hw, sy+hh+blockSize); ctx.lineTo(sx, sy+blockSize); ctx.fill();
    // Right
    ctx.fillStyle = colorRight;
    ctx.beginPath(); ctx.moveTo(sx+hw*2, sy); ctx.lineTo(sx+hw, sy+hh); ctx.lineTo(sx+hw, sy+hh+blockSize); ctx.lineTo(sx+hw*2, sy+blockSize); ctx.fill();
    
    ctx.strokeStyle = "rgba(0,0,0,0.1)"; ctx.stroke();
  };

  const draw = () => {
    ctx.fillStyle = "#87CEEB"; ctx.fillRect(0, 0, w, h); // sky
    
    const offset = time * 0.05;
    
    // We sort by x+y for isometric drawing back to front
    for (let sum = 0; sum < cols + rows; sum++) {
      for (let x = 0; x <= sum; x++) {
        const y = sum - x;
        if (x >= cols || y >= rows) continue;
        
        const noise = Math.sin((x + offset)*0.5) * Math.cos((y + offset)*0.5) * 3;
        const heightLevel = Math.floor(noise + 5);
        
        const sx = (x - y) * blockSize + w/2;
        const sy = (x + y) * blockSize * 0.5 - heightLevel * blockSize + h*0.2;
        
        if (heightLevel < 4) { // water
          drawBlock(sx, sy+blockSize*(4-heightLevel), "rgba(64,164,223,0.8)", "rgba(44,144,203,0.8)", "rgba(24,124,183,0.8)");
        } else if (heightLevel > 6) { // stone/snow
          drawBlock(sx, sy, "#fff", "#ddd", "#bbb");
        } else { // grass
          drawBlock(sx, sy, "#7ec850", "#8b5a2b", "#6a4a1b");
        }
      }
    }
    
    time++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateCameraPixelated(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const video = document.createElement("video");
  video.autoplay = true; video.muted = true;
  
  let streamRef: MediaStream | null = null;
  navigator.mediaDevices.getUserMedia({video: true}).then(stream => {
    streamRef = stream;
    video.srcObject = stream;
  }).catch(() => {});

  const offCanvas = document.createElement("canvas");
  offCanvas.width = 64; offCanvas.height = 48;
  const offCtx = offCanvas.getContext("2d")!;
  
  const draw = () => {
    if (!isActive()) {
      if (streamRef) streamRef.getTracks().forEach(t => t.stop());
      return;
    }
    
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
    
    if (video.readyState >= 2) {
      offCtx.drawImage(video, 0, 0, 64, 48);
      ctx.imageSmoothingEnabled = false;
      
      // Calculate aspect ratio fit
      const scale = Math.min(w / 64, h / 48);
      const dw = 64 * scale; const dh = 48 * scale;
      const dx = (w - dw)/2; const dy = (h - dh)/2;
      
      ctx.drawImage(offCanvas, dx, dy, dw, dh);
    } else {
      ctx.fillStyle = "#fff"; ctx.font = "20px monospace"; ctx.textAlign="center";
      ctx.fillText("Waiting for camera...", w/2, h/2);
    }
    
    setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateCameraMatrix(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const video = document.createElement("video");
  video.autoplay = true; video.muted = true;
  
  let streamRef: MediaStream | null = null;
  navigator.mediaDevices.getUserMedia({video: true}).then(stream => {
    streamRef = stream;
    video.srcObject = stream;
  }).catch(() => {});

  const fontSize = 14;
  const cols = Math.floor(w / fontSize);
  const rows = Math.floor(h / fontSize);
  
  const offCanvas = document.createElement("canvas");
  offCanvas.width = cols; offCanvas.height = rows;
  const offCtx = offCanvas.getContext("2d", { willReadFrequently: true })!;
  
  const chars = "アイウエオカキクケコサシスセソタチツテト0123456789";

  const draw = () => {
    if (!isActive()) {
      if (streamRef) streamRef.getTracks().forEach(t => t.stop());
      return;
    }
    
    ctx.fillStyle = "rgba(0, 0, 0, 0.2)"; ctx.fillRect(0, 0, w, h);
    
    if (video.readyState >= 2) {
      offCtx.drawImage(video, 0, 0, cols, rows);
      const data = offCtx.getImageData(0, 0, cols, rows).data;
      
      ctx.font = `${fontSize}px monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      
      for (let y=0; y<rows; y++) {
        for (let x=0; x<cols; x++) {
          const i = (y * cols + x) * 4;
          const r = data[i]; const g = data[i+1]; const b = data[i+2];
          const brightness = (r+g+b)/3;
          
          if (brightness > 30) {
            const char = chars[Math.floor(Math.random()*chars.length)];
            const lum = brightness / 255;
            ctx.fillStyle = `rgba(0, ${Math.floor(255 * lum)}, 0, ${lum})`;
            if (lum > 0.8) ctx.fillStyle = "#fff";
            
            ctx.fillText(char, x*fontSize + fontSize/2, y*fontSize + fontSize/2);
          }
        }
      }
    } else {
      ctx.fillStyle = "#0f0"; ctx.font = "20px monospace"; ctx.textAlign="center";
      ctx.fillText("Initializing Matrix Sensor...", w/2, h/2);
    }
    
    setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateRoblox(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const characters: {x:number, y:number, vx:number, vy:number, rot:number, vrot:number}[] = [];
  for(let i=0; i<5; i++) {
    characters.push({
      x: w/2, y: h/2,
      vx: (Math.random()-0.5)*4 + 2, vy: (Math.random()-0.5)*4 + 2,
      rot: 0, vrot: (Math.random()-0.5)*0.1
    });
  }

  const drawNoob = (x:number, y:number, rot:number) => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    
    // Head (Yellow)
    ctx.fillStyle = "#f5cd30"; ctx.fillRect(-15, -45, 30, 30);
    // Face
    ctx.fillStyle = "#000"; ctx.fillRect(-7, -35, 4, 4); ctx.fillRect(3, -35, 4, 4); // eyes
    ctx.fillRect(-5, -25, 10, 2); // smile
    // Torso (Blue)
    ctx.fillStyle = "#0055af"; ctx.fillRect(-20, -15, 40, 45);
    // Arms (Yellow)
    ctx.fillStyle = "#f5cd30"; ctx.fillRect(-35, -15, 15, 35); ctx.fillRect(20, -15, 15, 35);
    // Legs (Green)
    ctx.fillStyle = "#a1c45a"; ctx.fillRect(-20, 30, 18, 35); ctx.fillRect(2, 30, 18, 35);
    
    ctx.restore();
  };

  const draw = () => {
    ctx.fillStyle = "#222"; ctx.fillRect(0, 0, w, h);
    for (const c of characters) {
      c.x += c.vx; c.y += c.vy; c.rot += c.vrot;
      if (c.x < 40 || c.x > w-40) c.vx *= -1;
      if (c.y < 50 || c.y > h-50) c.vy *= -1;
      drawNoob(c.x, c.y, c.rot);
    }
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateAudioWaves(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let dataArray: Uint8Array | null = null;
  let streamRef: MediaStream | null = null;

  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    streamRef = stream;
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);
    analyser.fftSize = 128;
    dataArray = new Uint8Array(analyser.frequencyBinCount);
  }).catch(() => {});

  let time = 0;
  const draw = () => {
    if (!isActive()) {
      if (streamRef) streamRef.getTracks().forEach(t => t.stop());
      if (audioCtx) audioCtx.close();
      return;
    }
    
    ctx.fillStyle = "rgba(5, 5, 15, 0.3)"; ctx.fillRect(0, 0, w, h);
    
    const cx = w/2; const cy = h/2;
    const r = Math.min(w,h) * 0.2;
    
    if (analyser && dataArray) {
      analyser.getByteFrequencyData(dataArray);
      ctx.save(); ctx.translate(cx, cy);
      
      for (let i = 0; i < dataArray.length; i++) {
        const val = dataArray[i];
        const angle = (i / dataArray.length) * Math.PI * 2 + time*0.01;
        const length = r + val * 0.8;
        
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle)*r, Math.sin(angle)*r);
        ctx.lineTo(Math.cos(angle)*length, Math.sin(angle)*length);
        ctx.strokeStyle = `hsl(${(i/dataArray.length)*360 + time}, 100%, 50%)`;
        ctx.lineWidth = 4; ctx.lineCap = "round";
        ctx.stroke();
      }
      ctx.restore();
    } else {
      ctx.fillStyle = "#fff"; ctx.font = "16px monospace"; ctx.textAlign="center";
      ctx.fillText("Waiting for microphone...", cx, cy);
    }
    
    time++;
    setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateAiAgents(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const agents: {x:number, y:number, vx:number, vy:number, type:number}[] = [];
  for(let i=0; i<30; i++) {
    agents.push({x: Math.random()*w, y: Math.random()*h, vx: (Math.random()-0.5)*2, vy: (Math.random()-0.5)*2, type: Math.floor(Math.random()*3)});
  }
  
  const colors = ["#ff0055", "#00ffcc", "#ffcc00"];

  const draw = () => {
    ctx.fillStyle = "rgba(0, 0, 5, 0.2)"; ctx.fillRect(0, 0, w, h);
    
    for (const a of agents) {
      a.x += a.vx; a.y += a.vy;
      if (a.x < 0 || a.x > w) a.vx *= -1;
      if (a.y < 0 || a.y > h) a.vy *= -1;
      
      // Draw agent
      ctx.fillStyle = colors[a.type];
      ctx.beginPath(); ctx.arc(a.x, a.y, 4, 0, Math.PI*2); ctx.fill();
      
      // Connect to others
      for (const b of agents) {
        if (a === b) continue;
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        if (dist < 100) {
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = `rgba(255, 255, 255, ${0.1 * (1 - dist/100)})`;
          ctx.stroke();
          
          if (Math.random() < 0.01) {
            // "data packet"
            ctx.fillStyle = "#fff";
            ctx.beginPath(); ctx.arc(a.x + (b.x-a.x)*0.5, a.y + (b.y-a.y)*0.5, 2, 0, Math.PI*2); ctx.fill();
          }
        }
      }
    }
    
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animatePokemon(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const balls: {x:number, y:number, vx:number, vy:number, r:number, rot:number, vrot:number}[] = [];
  for(let i=0; i<8; i++) {
    balls.push({
      x: Math.random()*w, y: Math.random()*h, r: 25,
      vx: (Math.random()-0.5)*8, vy: (Math.random()-0.5)*8,
      rot: 0, vrot: (Math.random()-0.5)*0.2
    });
  }

  const draw = () => {
    ctx.fillStyle = "#8dc63f"; ctx.fillRect(0, 0, w, h); // grass
    
    for(const b of balls) {
      b.x += b.vx; b.y += b.vy; b.rot += b.vrot;
      if (b.x < b.r || b.x > w-b.r) b.vx *= -1;
      if (b.y < b.r || b.y > h-b.r) b.vy *= -1;
      
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.rot);
      
      // Top Red
      ctx.fillStyle = "#ee1515";
      ctx.beginPath(); ctx.arc(0, 0, b.r, Math.PI, Math.PI*2); ctx.fill();
      // Bottom White
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(0, 0, b.r, 0, Math.PI); ctx.fill();
      // Black divider
      ctx.fillStyle = "#222";
      ctx.fillRect(-b.r, -3, b.r*2, 6);
      // Center button
      ctx.beginPath(); ctx.arc(0, 0, 8, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI*2); ctx.fill();
      // Outline
      ctx.strokeStyle = "#222"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, b.r, 0, Math.PI*2); ctx.stroke();
      
      ctx.restore();
    }
    
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

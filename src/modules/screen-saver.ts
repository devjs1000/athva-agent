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
  | "pokemon"
  | "supernova"
  | "comet"
  | "meteor"
  | "sharingan"
  | "rinnegan";

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
  { id: "atoms", label: "Atoms", description: "Interacting atoms with forces" },
  { id: "galaxy", label: "Galaxy", description: "Swirling galactic particles" },
  { id: "solar-system", label: "Solar System", description: "Sun and orbiting planets" },
  { id: "uzumaki", label: "Uzumaki Spiral", description: "Hypnotic swirling spiral" },
  { id: "editor-skeleton", label: "Editor Loading", description: "Animated code skeleton" },
  { id: "slimes", label: "Slimes", description: "Bouncing blobby slimes" },
  { id: "file-names", label: "Files & Folders", description: "Floating project paths" },
  { id: "project-structure", label: "Project Tree", description: "Dynamic directory tree" },
  { id: "cosmos", label: "Cosmos", description: "Deep space cosmic clouds" },
  { id: "black-hole", label: "Black Hole", description: "Black hole with interaction system" },
  { id: "three-body", label: "Three-Body Problem", description: "Chaotic mass rotation" },
  { id: "neurons", label: "Neural Network", description: "Firing synapses" },
  { id: "dimensional-travel", label: "Dimensional Travel", description: "Enhanced hyperspace warp" },
  { id: "eyes", label: "Watching Eyes", description: "Blinking and looking around" },
  { id: "face", label: "Wireframe Face", description: "Abstract geometric face", requiresMic: true },
  { id: "forest", label: "Forest", description: "Scrolling tree silhouettes" },
  { id: "chatting", label: "Chatting", description: "Animated speech bubbles" },
  { id: "code-minimap", label: "Code Minimap", description: "Scrolling code structure" },
  { id: "single-eye", label: "Single Eye", description: "A solitary watching eye" },
  { id: "ai", label: "AI Core", description: "Advanced AI core system" },
  { id: "api-request", label: "API Requests", description: "Enhanced network traffic" },
  { id: "earth", label: "Earth Globe", description: "Rotating wireframe planet" },
  { id: "minecraft", label: "Voxel Terrain", description: "Isometric block generation" },
  { id: "camera-pixelated", label: "Pixel Cam", description: "Live pixelated webcam", requiresCamera: true },
  { id: "camera-matrix", label: "Matrix Cam", description: "Live webcam as Matrix code", requiresCamera: true },
  { id: "roblox", label: "Roblox", description: "Blocky characters bouncing" },
  { id: "audio-waves", label: "Audio Waves", description: "Microphone sound visualization", requiresMic: true },
  { id: "ai-agents", label: "AI Agents", description: "Swarm of interacting agents" },
  { id: "pokemon", label: "Pokemon", description: "Bouncing Pokeballs" },
  { id: "supernova", label: "Supernova", description: "Explosive stellar event" },
  { id: "comet", label: "Comet", description: "Icy comet with tail" },
  { id: "meteor", label: "Meteor", description: "Meteor shower system" },
  { id: "sharingan", label: "Sharingan", description: "Naruto's three-tomoe eye" },
  { id: "rinnegan", label: "Rinnegan", description: "Naruto's powerful ringed eye" }
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
    "supernova": animateSupernova,
    "comet": animateComet,
    "meteor": animateMeteor,
    "sharingan": animateSharingan,
    "rinnegan": animateRinnegan,
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
    ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
    ctx.fillRect(0, 0, w, h);
    ctx.font = `bold ${fontSize}px 'JetBrains Mono', monospace`;

    for (let i = 0; i < drops.length; i++) {
      const char = chars[Math.floor(Math.random() * chars.length)];
      const brightness = Math.random();
      
      // Enhanced color scheme with better vibrancy
      if (brightness > 0.98) {
        ctx.fillStyle = "#ffffff";
        ctx.shadowColor = "#39ff14";
        ctx.shadowBlur = 8;
      } else if (brightness > 0.85) {
        ctx.fillStyle = "#39ff14";
        ctx.shadowColor = "#39ff14";
        ctx.shadowBlur = 6;
      } else if (brightness > 0.7) {
        ctx.fillStyle = `rgba(57, 255, 20, ${0.7 + Math.random() * 0.3})`;
        ctx.shadowColor = "rgba(57, 255, 20, 0.5)";
        ctx.shadowBlur = 4;
      } else {
        ctx.fillStyle = `rgba(0, ${140 + Math.floor(Math.random() * 115)}, 10, ${0.5 + Math.random() * 0.5})`;
        ctx.shadowColor = "rgba(0, 200, 50, 0.3)";
        ctx.shadowBlur = 2;
      }
      
      ctx.fillText(char, i * fontSize, drops[i] * fontSize);
      ctx.shadowBlur = 0;
      
      if (drops[i] * fontSize > h && Math.random() > 0.97) drops[i] = 0;
      drops[i]++;
    }
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  
  ctx.fillStyle = "#000"; 
  ctx.fillRect(0, 0, w, h);
  draw();
}

function animateStarfield(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const numStars = Math.min(800, Math.floor(w * h / 1500));
  const stars: { x: number; y: number; z: number; brightness: number }[] = [];
  const cx = w / 2; const cy = h / 2;

  for (let i = 0; i < numStars; i++) {
    stars.push({ 
      x: (Math.random() - 0.5) * w * 2, 
      y: (Math.random() - 0.5) * h * 2, 
      z: Math.random() * w,
      brightness: Math.random() * 0.5 + 0.5
    });
  }

  const draw = () => {
    // Enhanced dark gradient background
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "#000005");
    grad.addColorStop(0.3, "#010010");
    grad.addColorStop(0.7, "#000015");
    grad.addColorStop(1, "#050005");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    
    for (const star of stars) {
      star.z -= w * 0.0025; 
      if (star.z <= 0) {
        star.x = (Math.random() - 0.5) * w * 2; 
        star.y = (Math.random() - 0.5) * h * 2; 
        star.z = w;
        star.brightness = Math.random() * 0.5 + 0.5;
      }
      
      const sx = cx + (star.x / star.z) * 350;
      const sy = cy + (star.y / star.z) * 350;
      const r = Math.max(0.5, (1 - star.z / w) * 3);
      const alpha = Math.max(0, 1 - star.z / w);
      const finalBrightness = alpha * star.brightness;
      
      // Star glow effect
      ctx.beginPath();
      ctx.arc(sx, sy, r * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(150, 180, 255, ${finalBrightness * 0.3})`;
      ctx.fill();
      
      // Star core
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(220, 240, 255, ${finalBrightness})`;
      ctx.fill();

      // Star trail (enhanced)
      const prevZ = star.z + w * 0.0025;
      const psx = cx + (star.x / prevZ) * 350;
      const psy = cy + (star.y / prevZ) * 350;
      ctx.beginPath();
      ctx.moveTo(psx, psy);
      ctx.lineTo(sx, sy);
      ctx.strokeStyle = `rgba(200, 220, 255, ${alpha * 0.5})`;
      ctx.lineWidth = r;
      ctx.stroke();
    }
    
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  
  ctx.fillStyle = "#000008";
  ctx.fillRect(0, 0, w, h);
  draw();
}

function animateParticleWaves(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const particles: { x: number; baseY: number; amplitude: number; frequency: number; speed: number; size: number; hue: number; phase: number }[] = [];
  const count = Math.min(250, Math.floor(w / 3.5));
  
  for (let i = 0; i < count; i++) {
    particles.push({
      x: Math.random() * w,
      baseY: h * 0.25 + Math.random() * h * 0.5,
      amplitude: 15 + Math.random() * h * 0.12,
      frequency: 0.0018 + Math.random() * 0.0045,
      speed: 0.25 + Math.random() * 0.95,
      size: 1.2 + Math.random() * 3.5,
      hue: 180 + Math.random() * 80,
      phase: Math.random() * Math.PI * 2
    });
  }
  
  let time = 0;
  
  const draw = () => {
    // Enhanced background with gradient
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, "rgba(8, 10, 20, 0.15)");
    bgGrad.addColorStop(0.5, "rgba(5, 15, 30, 0.1)");
    bgGrad.addColorStop(1, "rgba(8, 10, 20, 0.15)");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);
    
    for (const p of particles) {
      p.x += p.speed;
      if (p.x > w + 10) p.x = -10;
      
      const y = p.baseY + Math.sin(p.x * p.frequency + time * 0.025 + p.phase) * p.amplitude;
      const wave2 = Math.sin(p.x * p.frequency * 0.7 + time * 0.015 + p.phase * 1.3) * p.amplitude * 0.6;
      const finalY = y + wave2;
      
      const alphaWave = 0.35 + 0.5 * Math.sin(time * 0.012 + p.x * 0.008 + p.phase);
      const alpha = Math.max(0.2, alphaWave);
      
      // Particle glow
      ctx.beginPath();
      ctx.arc(p.x, finalY, p.size * 1.8, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${p.hue}, 85%, 65%, ${alpha * 0.4})`;
      ctx.fill();
      
      // Particle core
      ctx.beginPath();
      ctx.arc(p.x, finalY, p.size, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${p.hue}, 90%, 70%, ${alpha})`;
      ctx.fill();
    }
    
    time++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  
  ctx.fillStyle = "#0a0f1e";
  ctx.fillRect(0, 0, w, h);
  draw();
}

function animateDigitalClock(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const dots: { x: number; y: number; vx: number; vy: number; alpha: number }[] = [];
  for (let i = 0; i < Math.min(100, Math.floor(w / 8)); i++) {
    dots.push({ 
      x: Math.random() * w, 
      y: Math.random() * h, 
      vx: (Math.random() - 0.5) * 0.5, 
      vy: (Math.random() - 0.5) * 0.5, 
      alpha: 0.08 + Math.random() * 0.3 
    });
  }
  
  const draw = () => {
    // Enhanced background gradient
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, "rgba(5, 8, 20, 0.15)");
    bgGrad.addColorStop(0.5, "rgba(3, 5, 15, 0.1)");
    bgGrad.addColorStop(1, "rgba(5, 8, 20, 0.15)");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);
    
    // Draw particles with better visuals
    for (const d of dots) {
      d.x += d.vx;
      d.y += d.vy;
      if (d.x < 0 || d.x > w) d.vx *= -1;
      if (d.y < 0 || d.y > h) d.vy *= -1;
      
      // Particle glow
      ctx.beginPath();
      ctx.arc(d.x, d.y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(100, 180, 255, ${d.alpha * 0.3})`;
      ctx.fill();
      
      // Particle core
      ctx.beginPath();
      ctx.arc(d.x, d.y, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(120, 200, 255, ${d.alpha})`;
      ctx.fill();
    }
    
    // Draw connections between nearby dots
    for (let i = 0; i < dots.length; i++) {
      for (let j = i + 1; j < dots.length; j++) {
        const dist = Math.hypot(dots[i].x - dots[j].x, dots[i].y - dots[j].y);
        if (dist < 140) {
          ctx.beginPath();
          ctx.moveTo(dots[i].x, dots[i].y);
          ctx.lineTo(dots[j].x, dots[j].y);
          ctx.strokeStyle = `rgba(80, 160, 255, ${0.08 * (1 - dist / 140)})`;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }
    }
    
    // Time display with enhanced styling
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const dateStr = now.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    
    ctx.save();
    
    // Time display glow layer
    ctx.fillStyle = "rgba(100, 180, 255, 0.1)";
    ctx.shadowColor = "rgba(100, 180, 255, 0.4)";
    ctx.shadowBlur = 30;
    ctx.font = `bold ${Math.min(w * 0.14, 140)}px 'JetBrains Mono', monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(timeStr, w / 2, h / 2 - 15);
    
    // Time display main
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(180, 220, 255, 1)";
    ctx.font = `bold ${Math.min(w * 0.14, 140)}px 'JetBrains Mono', monospace`;
    ctx.fillText(timeStr, w / 2, h / 2 - 15);
    
    // Date display
    ctx.font = `300 ${Math.min(w * 0.028, 26)}px 'Segoe UI', sans-serif`;
    ctx.fillStyle = "rgba(140, 180, 220, 0.6)";
    ctx.fillText(dateStr, w / 2, h / 2 + Math.min(w * 0.08, 70));
    
    ctx.restore();
    
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  
  ctx.fillStyle = "#05050f";
  ctx.fillRect(0, 0, w, h);
  draw();
}

function animateAurora(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const bands = 6;
  const bandData: { baseY: number; hue: number; speed: number; amplitude: number; phase: number }[] = [];
  for (let i = 0; i < bands; i++) {
    bandData.push({ 
      baseY: h * 0.1 + (h * 0.6 / bands) * i, 
      hue: 120 + i * 35 + Math.random() * 20, 
      speed: 0.004 + Math.random() * 0.01, 
      amplitude: 20 + Math.random() * h * 0.15,
      phase: Math.random() * Math.PI * 2
    });
  }
  
  const stars: { x: number; y: number; r: number; twinkle: number }[] = [];
  for (let i = 0; i < Math.min(200, Math.floor(w / 8)); i++) {
    stars.push({ x: Math.random() * w, y: Math.random() * h * 0.5, r: 0.2 + Math.random() * 1.5, twinkle: Math.random() * Math.PI * 2 });
  }
  
  let time = 0;
  
  const draw = () => {
    // Enhanced gradient background
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "#000510");
    grad.addColorStop(0.3, "#020818");
    grad.addColorStop(0.5, "#050c25");
    grad.addColorStop(0.7, "#040a1a");
    grad.addColorStop(1, "#020508");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    
    // Twinkling stars with glow
    for (const s of stars) {
      s.twinkle += 0.015;
      const twinkleFactor = 0.25 + 0.65 * Math.abs(Math.sin(s.twinkle));
      
      // Star glow
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(200, 220, 255, ${twinkleFactor * 0.25})`;
      ctx.fill();
      
      // Star core
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(220, 240, 255, ${twinkleFactor})`;
      ctx.fill();
    }
    
    // Aurora bands with enhanced effects
    for (const band of bandData) {
      ctx.beginPath();
      for (let x = 0; x <= w; x += 8) {
        const wave1 = Math.sin(x * 0.0035 + time * band.speed) * band.amplitude;
        const wave2 = Math.sin(x * 0.0065 - time * band.speed * 1.4 + band.phase) * band.amplitude * 0.6;
        const wave3 = Math.sin(x * 0.0025 + time * band.speed * 0.7 + band.phase * 0.5) * band.amplitude * 0.35;
        const y = band.baseY + wave1 + wave2 + wave3;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      
      // Multi-color gradient for band
      const bandGrad = ctx.createLinearGradient(0, band.baseY - band.amplitude * 1.5, 0, band.baseY + band.amplitude * 2.5);
      bandGrad.addColorStop(0, `hsla(${band.hue}, 90%, 65%, 0)`);
      bandGrad.addColorStop(0.2, `hsla(${band.hue}, 85%, 60%, 0.12)`);
      bandGrad.addColorStop(0.4, `hsla(${band.hue}, 80%, 55%, 0.22)`);
      bandGrad.addColorStop(0.5, `hsla(${band.hue + 15}, 85%, 60%, 0.3)`);
      bandGrad.addColorStop(0.6, `hsla(${band.hue + 10}, 80%, 55%, 0.22)`);
      bandGrad.addColorStop(0.8, `hsla(${band.hue}, 85%, 60%, 0.12)`);
      bandGrad.addColorStop(1, `hsla(${band.hue}, 90%, 65%, 0)`);
      
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fillStyle = bandGrad;
      ctx.fill();
    }
    
    time++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  
  draw();
}

function animateGoldenRatio(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  let angle = 0;
  
  const draw = () => {
    // Enhanced background
    const bgGrad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h));
    bgGrad.addColorStop(0, "rgba(20, 10, 30, 0.1)");
    bgGrad.addColorStop(0.5, "rgba(10, 10, 20, 0.08)");
    bgGrad.addColorStop(1, "rgba(5, 5, 15, 0.1)");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);
    
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(angle);
    
    for (let i = 0; i < 400; i++) {
      const a = i * 137.5 * (Math.PI / 180);
      const r = Math.min(w, h) * 0.0015 * Math.sqrt(i) * 12;
      const x = r * Math.cos(a);
      const y = r * Math.sin(a);
      
      const size = Math.min(6, Math.sqrt(i) * 0.22);
      const hueValue = (i + angle * 80) % 360;
      const distance = i / 400;
      
      // Particle glow
      ctx.beginPath();
      ctx.arc(x, y, size * 1.5, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${hueValue}, 85%, 65%, ${(1 - distance) * 0.35})`;
      ctx.fill();
      
      // Particle core
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${hueValue}, 90%, 70%, ${1 - distance})`;
      ctx.fill();
    }
    
    ctx.restore();
    angle += 0.004;
    
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  
  ctx.fillStyle = "#0a0a12";
  ctx.fillRect(0, 0, w, h);
  draw();
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
  
  // Multiple atoms with interaction
  const atoms: {x: number, y: number, vx: number, vy: number, radius: number, nucleons: any[], orbits: any[]}[] = [];
  const atomCount = 5;
  
  for (let a = 0; a < atomCount; a++) {
    const nucleons: any[] = [];
    for (let i = 0; i < 12; i++) {
      nucleons.push({
        x: (Math.random() - 0.5) * 20, y: (Math.random() - 0.5) * 20,
        ox: Math.random() * Math.PI * 2, oy: Math.random() * Math.PI * 2,
        type: Math.random() > 0.5 ? 0 : 1
      });
    }
    
    atoms.push({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * 1.5, vy: (Math.random() - 0.5) * 1.5,
      radius: 80 + Math.random() * 60,
      nucleons,
      orbits: [
        {rx: 100, ry: 30, angle: 0, electrons: [0, Math.PI]},
        {rx: 130, ry: 40, angle: Math.PI/3, electrons: [Math.PI/2, Math.PI*1.5]},
      ]
    });
  }
  
  const draw = () => {
    const bgGrad = ctx.createRadialGradient(w/2, h/2, 0, w/2, h/2, Math.max(w, h));
    bgGrad.addColorStop(0, "rgba(15, 10, 25, 0.4)");
    bgGrad.addColorStop(0.5, "rgba(8, 8, 15, 0.2)");
    bgGrad.addColorStop(1, "rgba(5, 5, 10, 0.35)");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);
    
    // Update atom positions with interactions
    for (let i = 0; i < atoms.length; i++) {
      const atom = atoms[i];
      atom.x += atom.vx;
      atom.y += atom.vy;
      
      // Bounce off edges
      if (atom.x - atom.radius < 0 || atom.x + atom.radius > w) atom.vx *= -1;
      if (atom.y - atom.radius < 0 || atom.y + atom.radius > h) atom.vy *= -1;
      
      // Keep in bounds
      atom.x = Math.max(atom.radius, Math.min(w - atom.radius, atom.x));
      atom.y = Math.max(atom.radius, Math.min(h - atom.radius, atom.y));
      
      // Atom-to-atom interactions
      for (let j = i + 1; j < atoms.length; j++) {
        const other = atoms[j];
        const dx = other.x - atom.x;
        const dy = other.y - atom.y;
        const dist = Math.hypot(dx, dy);
        const minDist = atom.radius + other.radius;
        
        if (dist < minDist * 2) {
          // Attraction force
          const force = (minDist * 2 - dist) * 0.0005;
          atom.vx += (dx / dist) * force;
          atom.vy += (dy / dist) * force;
          
          // Draw connection line when close
          if (dist < minDist * 1.5) {
            ctx.beginPath();
            ctx.moveTo(atom.x, atom.y);
            ctx.lineTo(other.x, other.y);
            ctx.strokeStyle = `rgba(100, 180, 255, ${0.2 * (1 - dist / (minDist * 1.5))})`;
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
      }
    }
    
    // Draw all atoms
    for (const atom of atoms) {
      ctx.save();
      ctx.translate(atom.x, atom.y);
      
      // Atom boundary
      ctx.beginPath();
      ctx.arc(0, 0, atom.radius, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(100, 150, 255, 0.15)";
      ctx.lineWidth = 1;
      ctx.stroke();
      
      // Draw orbits
      for (const o of atom.orbits) {
        ctx.save();
        ctx.rotate(o.angle + time * 0.005);
        
        ctx.beginPath();
        ctx.ellipse(0, 0, o.rx, o.ry, 0, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(80, 150, 255, 0.15)";
        ctx.lineWidth = 0.8;
        ctx.stroke();
        
        // Electrons
        for (let i = 0; i < o.electrons.length; i++) {
          o.electrons[i] += 0.08 + i * 0.01;
          const ex = Math.cos(o.electrons[i]) * o.rx;
          const ey = Math.sin(o.electrons[i]) * o.ry;
          
          ctx.beginPath();
          ctx.arc(ex, ey, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = "#00ffff";
          ctx.shadowColor = "#00ffff";
          ctx.shadowBlur = 10;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
        ctx.restore();
      }
      
      // Nucleus
      for (const n of atom.nucleons) {
        const vx = n.x + Math.sin(time * 0.08 + n.ox) * 3;
        const vy = n.y + Math.cos(time * 0.08 + n.oy) * 3;
        
        const isProton = n.type === 0;
        const color = isProton ? "#ff5555" : "#5555ff";
        
        ctx.beginPath();
        ctx.arc(vx, vy, 6, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      
      ctx.restore();
    }
    
    time++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  
  ctx.fillStyle = "#0a0a15";
  ctx.fillRect(0, 0, w, h);
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
    
    // Enhanced background with gradient
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, "rgba(0, 0, 8, 0.25)");
    bgGrad.addColorStop(0.5, "rgba(0, 0, 3, 0.15)");
    bgGrad.addColorStop(1, "rgba(0, 0, 8, 0.25)");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);
    
    ctx.save();
    ctx.translate(w/2, h/2);
    ctx.rotate(rotation);
    ctx.scale(1, 0.65); // tilt galaxy
    
    ctx.globalCompositeOperation = "lighter";
    
    // Core glow with enhanced visuals
    const coreGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, maxRadius * 0.25);
    coreGrad.addColorStop(0, "rgba(255, 250, 200, 0.5)");
    coreGrad.addColorStop(0.3, "rgba(255, 200, 100, 0.3)");
    coreGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = coreGrad;
    const coreSize = maxRadius * 0.25;
    ctx.fillRect(-coreSize, -coreSize, coreSize * 2, coreSize * 2);

    for (const p of particles) {
      p.theta -= 0.0005 + (0.012 / (p.r / 50 + 1));
      
      const px = Math.cos(p.theta) * p.r + Math.cos(p.theta + Math.PI / 2) * p.a;
      const py = Math.sin(p.theta) * p.r + Math.sin(p.theta + Math.PI / 2) * p.a;
      
      // Particle glow
      const glowSize = p.s * 2.5;
      ctx.beginPath();
      ctx.arc(px, py, glowSize, 0, Math.PI * 2);
      const glowColor = p.color.replace('hsla', 'hsla').slice(0, -1) + ', 0.3)';
      ctx.fillStyle = glowColor;
      ctx.fill();
      
      // Particle core
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(px, py, p.s, 0, Math.PI * 2);
      ctx.fill();
    }
    
    ctx.restore();
    rotation += 0.0008;
    
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateSolarSystem(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  let time = 0;
  const baseScale = Math.min(w, h) / 380;
  const planets = [
    { dist: 40 * baseScale, size: 2.5 * baseScale, speed: 0.04, color: "#888", glow: "rgba(136, 136, 136, 0.5)" },
    { dist: 70 * baseScale, size: 4.5 * baseScale, speed: 0.03, color: "#d89060", glow: "rgba(216, 144, 96, 0.5)" },
    { dist: 110 * baseScale, size: 5 * baseScale, speed: 0.02, color: "#5599ff", glow: "rgba(85, 153, 255, 0.5)" },
    { dist: 150 * baseScale, size: 3 * baseScale, speed: 0.015, color: "#ff6644", glow: "rgba(255, 102, 68, 0.5)" },
    { dist: 220 * baseScale, size: 11 * baseScale, speed: 0.008, color: "#ffcc99", glow: "rgba(255, 204, 153, 0.5)" },
    { dist: 290 * baseScale, size: 8.5 * baseScale, speed: 0.006, color: "#ffeecc", glow: "rgba(255, 238, 204, 0.5)" }
  ];
  
  const draw = () => {
    // Enhanced background
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, "rgba(5, 5, 15, 0.3)");
    bgGrad.addColorStop(0.5, "rgba(2, 2, 8, 0.2)");
    bgGrad.addColorStop(1, "rgba(5, 5, 15, 0.3)");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);
    
    ctx.save();
    ctx.translate(w / 2, h / 2);
    
    // Sun with enhanced glow
    const sunGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, 20 * baseScale);
    sunGrad.addColorStop(0, "#ffff99");
    sunGrad.addColorStop(0.5, "#ffdd44");
    sunGrad.addColorStop(1, "#ff8800");
    ctx.fillStyle = sunGrad;
    ctx.beginPath();
    ctx.arc(0, 0, 15 * baseScale, 0, Math.PI * 2);
    ctx.fill();
    
    // Sun outer glow
    ctx.beginPath();
    ctx.arc(0, 0, 20 * baseScale, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 200, 0, 0.25)";
    ctx.fill();
    
    // Sun shadow
    ctx.shadowColor = "#ffaa00";
    ctx.shadowBlur = 35 * baseScale;
    ctx.beginPath();
    ctx.arc(0, 0, 15 * baseScale, 0, Math.PI * 2);
    ctx.fillStyle = "#ffdd00";
    ctx.fill();
    ctx.shadowBlur = 0;

    for (const p of planets) {
      // Orbit line
      ctx.beginPath();
      ctx.arc(0, 0, p.dist, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(150, 200, 255, 0.08)";
      ctx.lineWidth = 1;
      ctx.stroke();
      
      const angle = time * p.speed;
      const x = Math.cos(angle) * p.dist;
      const y = Math.sin(angle) * p.dist;
      
      // Planet glow
      ctx.beginPath();
      ctx.arc(x, y, p.size * 1.8, 0, Math.PI * 2);
      ctx.fillStyle = p.glow;
      ctx.fill();
      
      // Planet core
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.5, p.size), 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8 * baseScale;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    
    ctx.restore();
    time++;
    
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  
  ctx.fillStyle = "#05050a";
  ctx.fillRect(0, 0, w, h);
  draw();
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
  const cx = w / 2;
  const cy = h / 2;
  const horizon = Math.max(28, Math.min(w, h) * 0.075);
  const photonRing = horizon * 1.32;
  const diskInner = horizon * 1.55;
  const diskOuter = Math.min(w, h) * 0.42;
  const gravity = Math.min(w, h) * 0.23;
  const diskTilt = 0.24;
  const starCount = Math.min(260, Math.floor(w * h / 5200));
  const diskCount = Math.min(620, Math.floor(w * h / 1900));

  const stars = Array.from({ length: starCount }, (_, i) => {
    const seed = Math.sin(i * 127.1) * 10000;
    return {
      x: ((seed - Math.floor(seed)) * w),
      y: ((Math.sin(i * 311.7) * 10000) % 1 + 1) % 1 * h,
      r: 0.35 + (((Math.sin(i * 53.9) * 10000) % 1 + 1) % 1) * 1.2,
      twinkle: i * 0.37
    };
  });

  const seedParticle = (nearOuter = false) => {
    const radius = nearOuter
      ? diskOuter * (0.78 + Math.random() * 0.22)
      : diskInner + Math.pow(Math.random(), 0.72) * (diskOuter - diskInner);
    const angle = Math.random() * Math.PI * 2;
    const orbital = Math.sqrt(gravity / Math.max(radius, 1));
    const spiralBias = -0.025 - Math.random() * 0.025;
    return {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius * diskTilt,
      vx: -Math.sin(angle) * orbital + Math.cos(angle) * spiralBias,
      vy: (Math.cos(angle) * orbital + Math.sin(angle) * spiralBias) * diskTilt,
      heat: Math.random(),
      mass: 0.65 + Math.random() * 1.35,
      trail: [] as { x: number; y: number }[]
    };
  };

  const particles = Array.from({ length: diskCount }, () => seedParticle());
  
  const draw = () => {
    const bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.7);
    bgGrad.addColorStop(0, "#020204");
    bgGrad.addColorStop(0.45, "#030711");
    bgGrad.addColorStop(1, "#000208");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    for (const s of stars) {
      const dx = s.x - cx;
      const dy = s.y - cy;
      const d = Math.hypot(dx, dy);
      const lens = Math.max(0, 1 - d / (diskOuter * 1.45));
      const bend = lens * lens * horizon * 0.4 / Math.max(d, 1);
      const sx = s.x + dx * bend;
      const sy = s.y + dy * bend;
      const alpha = 0.18 + 0.55 * Math.abs(Math.sin(time * 0.012 + s.twinkle));
      ctx.fillStyle = `rgba(215, 230, 255, ${alpha * (1 - lens * 0.45)})`;
      ctx.beginPath();
      ctx.arc(sx, sy, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.18);
    const halo = ctx.createRadialGradient(0, 0, horizon * 0.9, 0, 0, diskOuter * 1.35);
    halo.addColorStop(0, "rgba(255, 245, 190, 0.42)");
    halo.addColorStop(0.12, "rgba(255, 150, 45, 0.24)");
    halo.addColorStop(0.45, "rgba(93, 75, 255, 0.09)");
    halo.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.scale(1, 0.42);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, diskOuter * 1.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.globalCompositeOperation = "lighter";
    for (const p of particles) {
      p.trail.push({ x: p.x, y: p.y });
      if (p.trail.length > 9) p.trail.shift();

      const dx = cx - p.x;
      const dy = (cy - p.y) / diskTilt;
      const dist = Math.max(3, Math.hypot(dx, dy));
      const ax = dx / dist * gravity / (dist * dist);
      const ay = dy / dist * gravity / (dist * dist) * diskTilt;
      const drag = dist < diskInner * 1.35 ? 0.986 : 0.996;

      p.vx = (p.vx + ax) * drag;
      p.vy = (p.vy + ay) * drag;
      p.x += p.vx * p.mass;
      p.y += p.vy * p.mass;
      p.heat = Math.min(1, p.heat + Math.max(0, (diskOuter - dist) / diskOuter) * 0.012);

      if (dist < horizon * 0.88 || dist > diskOuter * 1.55 || p.x < -80 || p.x > w + 80 || p.y < -80 || p.y > h + 80) {
        Object.assign(p, seedParticle(true));
        continue;
      }

      const trailStart = p.trail[0] || p;
      const alpha = Math.min(0.9, 0.18 + p.heat * 0.72) * Math.max(0, 1 - dist / (diskOuter * 1.35));
      const hue = 34 + p.heat * 30;
      ctx.beginPath();
      ctx.moveTo(trailStart.x, trailStart.y);
      ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = `hsla(${hue}, 100%, ${58 + p.heat * 20}%, ${alpha})`;
      ctx.lineWidth = 0.8 + p.heat * 1.5;
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.18);
    ctx.scale(1, 0.38);
    const doppler = ctx.createLinearGradient(-diskOuter, 0, diskOuter, 0);
    doppler.addColorStop(0, "rgba(210, 40, 20, 0.18)");
    doppler.addColorStop(0.55, "rgba(255, 210, 110, 0.08)");
    doppler.addColorStop(1, "rgba(110, 190, 255, 0.25)");
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = doppler;
    ctx.beginPath();
    ctx.ellipse(0, 0, diskOuter, diskOuter * 0.58, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();

    const ring = ctx.createRadialGradient(cx, cy, horizon * 0.86, cx, cy, photonRing * 1.35);
    ring.addColorStop(0, "rgba(0, 0, 0, 0)");
    ring.addColorStop(0.52, "rgba(255, 230, 155, 0.95)");
    ring.addColorStop(0.72, "rgba(255, 111, 38, 0.36)");
    ring.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = ring;
    ctx.beginPath();
    ctx.arc(cx, cy, photonRing * 1.35, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowColor = "rgba(255, 145, 45, 0.55)";
    ctx.shadowBlur = horizon * 0.55;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(cx, cy, horizon, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    const lensShade = ctx.createRadialGradient(cx, cy, horizon * 0.75, cx, cy, diskInner * 1.15);
    lensShade.addColorStop(0, "rgba(0, 0, 0, 1)");
    lensShade.addColorStop(0.62, "rgba(0, 0, 0, 0.62)");
    lensShade.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = lensShade;
    ctx.beginPath();
    ctx.arc(cx, cy, diskInner * 1.15, 0, Math.PI * 2);
    ctx.fill();

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
  let time = 0;
  const portals: {x:number, y:number, size:number, rotation:number, depth:number}[] = [];
  const warpParticles: {x:number, y:number, vx:number, vy:number, life:number, maxLife:number}[] = [];
  
  // Generate portals
  for (let i = 0; i < 4; i++) {
    portals.push({
      x: (i % 2) * w * 0.7 + w * 0.15,
      y: Math.floor(i / 2) * h * 0.7 + h * 0.15,
      size: 60 + Math.random() * 40,
      rotation: Math.random() * Math.PI * 2,
      depth: Math.random()
    });
  }
  
  const draw = () => {
    // Hyperspace background
    const bgGrad = ctx.createLinearGradient(0, 0, w, h);
    bgGrad.addColorStop(0, "rgba(10, 0, 30, 0.9)");
    bgGrad.addColorStop(0.5, "rgba(30, 10, 60, 0.9)");
    bgGrad.addColorStop(1, "rgba(10, 0, 30, 0.9)");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);
    
    // Draw star field moving toward camera
    for (let i = 0; i < 50; i++) {
      const seed = i * 7373;
      const x = (Math.sin(seed) * w + time * 2) % w;
      const y = (Math.cos(seed) * h + time * 1.5) % h;
      const size = 0.5 + Math.sin(time * 0.02 + seed) * 0.5;
      ctx.fillStyle = `rgba(200, 150, 255, ${0.3 + 0.3 * Math.cos(time * 0.01 + seed)})`;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    
    // Draw warp grid
    ctx.strokeStyle = "rgba(100, 200, 255, 0.15)";
    ctx.lineWidth = 1;
    const gridSize = 60 + Math.sin(time * 0.01) * 20;
    for (let x = 0; x < w; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      const warp = Math.sin(time * 0.01 + x * 0.01) * 30;
      for (let y = 0; y < h; y += 10) {
        ctx.lineTo(x + warp * Math.sin(y * 0.02), y);
      }
      ctx.stroke();
    }
    
    for (let y = 0; y < h; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      const warp = Math.cos(time * 0.01 + y * 0.01) * 30;
      for (let x = 0; x < w; x += 10) {
        ctx.lineTo(x, y + warp * Math.cos(x * 0.02));
      }
      ctx.stroke();
    }
    
    // Update and draw portals
    for (const portal of portals) {
      portal.rotation += 0.03;
      portal.depth = 0.5 + 0.5 * Math.sin(time * 0.005 + portal.x);
      
      ctx.save();
      ctx.translate(portal.x, portal.y);
      ctx.rotate(portal.rotation);
      
      // Portal rings
      for (let ring = 0; ring < 3; ring++) {
        const size = portal.size * (1 - ring * 0.25) * (0.8 + 0.2 * portal.depth);
        ctx.beginPath();
        ctx.arc(0, 0, size, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${100 + ring * 50}, ${150}, ${255 - ring * 50}, ${(1 - ring * 0.3) * portal.depth})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      
      // Portal vortex effect
      ctx.fillStyle = `rgba(150, 100, 255, ${0.2 * portal.depth})`;
      ctx.beginPath();
      ctx.arc(0, 0, portal.size * 0.7, 0, Math.PI * 2);
      ctx.fill();
      
      // Spiral into portal
      ctx.strokeStyle = `rgba(200, 150, 255, ${0.4 * portal.depth})`;
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 6; i++) {
        ctx.beginPath();
        for (let a = 0; a < Math.PI * 2; a += 0.1) {
          const r = (portal.size * 0.6) * (1 - (i + a / (Math.PI * 2)) / 6);
          const x = Math.cos(a) * r;
          const y = Math.sin(a) * r;
          if (a === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      
      ctx.restore();
      
      // Generate warp particles around portal
      if (Math.random() < 0.3) {
        const angle = Math.random() * Math.PI * 2;
        const dist = portal.size * (0.7 + Math.random() * 0.5);
        warpParticles.push({
          x: portal.x + Math.cos(angle) * dist,
          y: portal.y + Math.sin(angle) * dist,
          vx: Math.cos(angle + Math.PI) * (1 + Math.random()),
          vy: Math.sin(angle + Math.PI) * (1 + Math.random()),
          life: 1,
          maxLife: 1
        });
      }
    }
    
    // Update and draw warp particles
    for (let i = warpParticles.length - 1; i >= 0; i--) {
      const p = warpParticles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.02;
      p.vx *= 0.98;
      p.vy *= 0.98;
      
      if (p.life > 0) {
        ctx.fillStyle = `rgba(200, 150, 255, ${p.life * 0.6})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1 + Math.random() * 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        warpParticles.splice(i, 1);
      }
    }
    
    time++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  
  draw();
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
  let volumeSmooth = 0;
  let blink = 0;
  let nextBlink = 120;
  
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

    const bg = ctx.createRadialGradient(w / 2, h * 0.38, 0, w / 2, h / 2, Math.max(w, h) * 0.82);
    bg.addColorStop(0, "#f9fcff");
    bg.addColorStop(0.58, "#eef6ff");
    bg.addColorStop(1, "#dbeafe");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    
    let volume = 0;
    if (analyser && dataArray) {
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for(let i=0; i<dataArray.length; i++) sum += dataArray[i];
      volume = Math.min(1, (sum / dataArray.length) / 120);
    }
    volumeSmooth += (volume - volumeSmooth) * 0.18;

    if (time > nextBlink) {
      blink = 1;
      nextBlink = time + 120 + Math.random() * 170;
    }
    blink *= 0.72;

    const scale = Math.min(w, h) / 620;
    const bob = Math.sin(time * 0.035) * 8 * scale + volumeSmooth * 10 * scale;
    const cx = w / 2 + Math.sin(time * 0.012) * 8 * scale;
    const cy = h / 2 - 16 * scale + bob;
    const navy = "#24436f";
    const light = "#dff1ff";
    const eye = "#83c6f2";

    const roundedRect = (x: number, y: number, width: number, height: number, radius: number) => {
      const r = Math.min(radius, width / 2, height / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + width - r, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + r);
      ctx.lineTo(x + width, y + height - r);
      ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
      ctx.lineTo(x + r, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    };

    const drawLimb = (side: number) => {
      const shoulderX = cx + side * 76 * scale;
      const shoulderY = cy + 86 * scale;
      const handX = cx + side * 110 * scale;
      const handY = cy + 165 * scale + Math.sin(time * 0.045 + side) * 7 * scale;

      ctx.lineWidth = 10 * scale;
      ctx.strokeStyle = navy;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(shoulderX, shoulderY);
      ctx.quadraticCurveTo(cx + side * 104 * scale, cy + 112 * scale, handX, handY - 18 * scale);
      ctx.stroke();

      const armGrad = ctx.createLinearGradient(shoulderX, shoulderY, handX, handY);
      armGrad.addColorStop(0, "#eef8ff");
      armGrad.addColorStop(1, "#a7d4f4");
      ctx.lineWidth = 26 * scale;
      ctx.strokeStyle = armGrad;
      ctx.beginPath();
      ctx.moveTo(shoulderX, shoulderY + 10 * scale);
      ctx.quadraticCurveTo(cx + side * 100 * scale, cy + 122 * scale, handX, handY);
      ctx.stroke();

      ctx.fillStyle = navy;
      ctx.beginPath();
      ctx.arc(handX, handY, 31 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = light;
      ctx.beginPath();
      ctx.arc(handX, handY, 22 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = navy;
      ctx.beginPath();
      ctx.arc(handX + side * 8 * scale, handY, 13 * scale, 0, Math.PI * 2);
      ctx.fill();
    };

    ctx.fillStyle = "rgba(24, 54, 91, 0.3)";
    ctx.beginPath();
    ctx.ellipse(cx, cy + 202 * scale, 58 * scale, 12 * scale, 0, 0, Math.PI * 2);
    ctx.fill();

    drawLimb(-1);
    drawLimb(1);

    ctx.lineWidth = 7 * scale;
    ctx.strokeStyle = navy;
    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.moveTo(cx - 62 * scale, cy + 68 * scale);
    ctx.bezierCurveTo(cx - 54 * scale, cy + 176 * scale, cx + 54 * scale, cy + 176 * scale, cx + 62 * scale, cy + 68 * scale);
    ctx.lineTo(cx + 38 * scale, cy + 58 * scale);
    ctx.bezierCurveTo(cx + 32 * scale, cy + 134 * scale, cx - 32 * scale, cy + 134 * scale, cx - 38 * scale, cy + 58 * scale);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    const coreGrad = ctx.createLinearGradient(cx, cy + 70 * scale, cx, cy + 154 * scale);
    coreGrad.addColorStop(0, "#dff1ff");
    coreGrad.addColorStop(1, "#9cc7e2");
    ctx.fillStyle = coreGrad;
    roundedRect(cx - 12 * scale, cy + 70 * scale, 24 * scale, 90 * scale, 12 * scale);
    ctx.fill();

    ctx.lineWidth = 8 * scale;
    ctx.strokeStyle = navy;
    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.ellipse(cx, cy - 18 * scale, 114 * scale, 86 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.lineWidth = 7 * scale;
    ctx.strokeStyle = navy;
    ctx.beginPath();
    ctx.arc(cx, cy - 25 * scale, 118 * scale, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();

    ctx.fillStyle = navy;
    ctx.beginPath();
    ctx.arc(cx - 113 * scale, cy - 20 * scale, 24 * scale, Math.PI * 0.5, Math.PI * 1.5);
    ctx.arc(cx - 113 * scale, cy + 24 * scale, 24 * scale, Math.PI * 1.5, Math.PI * 0.5);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + 113 * scale, cy - 20 * scale, 24 * scale, Math.PI * 1.5, Math.PI * 0.5);
    ctx.arc(cx + 113 * scale, cy + 24 * scale, 24 * scale, Math.PI * 0.5, Math.PI * 1.5);
    ctx.fill();
    ctx.fillStyle = light;
    ctx.beginPath(); ctx.arc(cx - 122 * scale, cy + 8 * scale, 7 * scale, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + 122 * scale, cy + 8 * scale, 7 * scale, 0, Math.PI * 2); ctx.fill();

    const visorGrad = ctx.createLinearGradient(cx, cy - 78 * scale, cx, cy + 40 * scale);
    visorGrad.addColorStop(0, "#3f639b");
    visorGrad.addColorStop(0.58, "#2f4f84");
    visorGrad.addColorStop(1, "#172a4a");
    ctx.fillStyle = visorGrad;
    ctx.beginPath();
    ctx.ellipse(cx, cy - 18 * scale, 86 * scale, 61 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
    ctx.beginPath();
    ctx.ellipse(cx, cy - 45 * scale, 78 * scale, 30 * scale, 0, Math.PI, 0);
    ctx.fill();

    const eyeOpen = Math.max(0.14, 1 - blink);
    const eyePulse = 1 + volumeSmooth * 0.18 + Math.sin(time * 0.04) * 0.04;
    for (const side of [-1, 1]) {
      ctx.fillStyle = eye;
      ctx.shadowColor = "rgba(131, 198, 242, 0.75)";
      ctx.shadowBlur = 14 * scale;
      ctx.beginPath();
      ctx.ellipse(cx + side * 34 * scale, cy - 20 * scale, 16 * scale * eyePulse, 24 * scale * eyeOpen, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    if (volumeSmooth > 0.04) {
      ctx.strokeStyle = `rgba(131, 198, 242, ${Math.min(0.75, volumeSmooth)})`;
      ctx.lineWidth = 4 * scale;
      ctx.beginPath();
      ctx.arc(cx, cy + 6 * scale, (42 + volumeSmooth * 12) * scale, 0.18 * Math.PI, 0.82 * Math.PI);
      ctx.stroke();
    }
    time++;
    setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateAi(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  let time = 0;
  const cores: {x:number, y:number, size:number, energy:number, connections:number[]}[] = [];
  const pulses: {x:number, y:number, size:number, maxSize:number, life:number}[] = [];
  const neurons: {x:number, y:number, vx:number, vy:number, charge:number}[] = [];
  
  // Create main core
  cores.push({ x: w * 0.5, y: h * 0.5, size: 80, energy: 0.8, connections: [1, 2, 3] });
  
  // Create secondary cores
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2 + Math.PI * 0.5;
    cores.push({
      x: w * 0.5 + Math.cos(angle) * w * 0.25,
      y: h * 0.5 + Math.sin(angle) * h * 0.25,
      size: 50,
      energy: 0.5,
      connections: [Math.floor(Math.random() * cores.length)]
    });
  }
  
  // Create neural network
  for (let i = 0; i < 20; i++) {
    neurons.push({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.5,
      vy: (Math.random() - 0.5) * 0.5,
      charge: 0
    });
  }
  
  const draw = () => {
    // Dark background with gradient
    const bgGrad = ctx.createRadialGradient(w * 0.5, h * 0.5, 0, w * 0.5, h * 0.5, Math.hypot(w, h) * 0.7);
    bgGrad.addColorStop(0, "rgba(20, 10, 40, 0.8)");
    bgGrad.addColorStop(1, "rgba(5, 5, 15, 0.95)");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);
    
    // Update neural positions
    for (const n of neurons) {
      n.x += n.vx;
      n.y += n.vy;
      n.charge *= 0.95;
      
      if (n.x < 0 || n.x > w) n.vx *= -1;
      if (n.y < 0 || n.y > h) n.vy *= -1;
    }
    
    // Update cores
    for (const core of cores) {
      core.energy = 0.5 + 0.5 * Math.sin(time * 0.01 + core.x);
      
      // Emit pulses
      if (Math.random() < 0.05) {
        pulses.push({
          x: core.x,
          y: core.y,
          size: 0,
          maxSize: core.size * 3,
          life: 1
        });
      }
    }
    
    // Draw neural network connections
    for (let i = 0; i < neurons.length; i++) {
      for (let j = i + 1; j < neurons.length; j++) {
        const dist = Math.hypot(neurons[i].x - neurons[j].x, neurons[i].y - neurons[j].y);
        if (dist < 120) {
          ctx.beginPath();
          ctx.moveTo(neurons[i].x, neurons[i].y);
          ctx.lineTo(neurons[j].x, neurons[j].y);
          ctx.strokeStyle = `rgba(100, 150, 255, ${0.1 * (1 - dist / 120)})`;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }
    }
    
    // Draw neurons
    for (const n of neurons) {
      const chargeColor = Math.floor(200 + n.charge * 55);
      ctx.beginPath();
      ctx.arc(n.x, n.y, 2 + n.charge * 3, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${chargeColor}, 100, 255, 0.7)`;
      ctx.shadowColor = `rgba(${chargeColor}, 150, 255, 0.8)`;
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    
    // Draw cores and their connections
    for (let i = 0; i < cores.length; i++) {
      const core = cores[i];
      
      // Connection lines to other cores
      for (const connIdx of core.connections) {
        if (connIdx < cores.length) {
          const target = cores[connIdx];
          ctx.beginPath();
          ctx.moveTo(core.x, core.y);
          ctx.lineTo(target.x, target.y);
          ctx.strokeStyle = `rgba(150, 100, 255, ${0.2 * core.energy})`;
          ctx.lineWidth = 2;
          ctx.stroke();
          
          // Signal travel animation
          const t = (time * 0.02) % 1;
          const sx = core.x + (target.x - core.x) * t;
          const sy = core.y + (target.y - core.y) * t;
          ctx.fillStyle = `rgba(200, 150, 255, ${(1 - t) * 0.8})`;
          ctx.beginPath();
          ctx.arc(sx, sy, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      
      // Core glow layers
      ctx.shadowColor = `rgba(150, 100, 255, ${core.energy})`;
      ctx.shadowBlur = 30;
      
      ctx.beginPath();
      ctx.arc(core.x, core.y, core.size, 0, Math.PI * 2);
      const coreGrad = ctx.createRadialGradient(core.x, core.y, 0, core.x, core.y, core.size);
      coreGrad.addColorStop(0, `rgba(200, 150, 255, ${0.8 * core.energy})`);
      coreGrad.addColorStop(0.5, `rgba(100, 50, 200, ${0.4 * core.energy})`);
      coreGrad.addColorStop(1, `rgba(50, 20, 100, ${0.1 * core.energy})`);
      ctx.fillStyle = coreGrad;
      ctx.fill();
      
      // Core ring
      ctx.strokeStyle = `rgba(150, 100, 255, ${0.6 * core.energy})`;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.shadowBlur = 0;
      
      // Rotating energy rings
      ctx.save();
      ctx.translate(core.x, core.y);
      ctx.rotate(time * 0.01);
      
      for (let ring = 1; ring <= 2; ring++) {
        ctx.beginPath();
        ctx.arc(0, 0, core.size * 0.6 * ring, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${150 - ring * 30}, ${100 - ring * 20}, ${255 - ring * 50}, ${(0.4 - ring * 0.1) * core.energy})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      
      ctx.restore();
    }
    
    // Update and draw pulses
    for (let i = pulses.length - 1; i >= 0; i--) {
      const pulse = pulses[i];
      pulse.size += pulse.maxSize * 0.05;
      pulse.life -= 0.02;
      
      if (pulse.life > 0) {
        ctx.beginPath();
        ctx.arc(pulse.x, pulse.y, pulse.size, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(150, 100, 255, ${pulse.life * 0.3})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        pulses.splice(i, 1);
      }
    }
    
    time++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  
  draw();
}


function animateApiRequest(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  const requests: {x:number, y:number, targetX:number, targetY:number, progress:number, phase:number, text:string, color:string, isResponse:boolean}[] = [];
  const methods = [
    {t: "GET /users", c: "#569cd6"}, {t: "POST /auth", c: "#4ec9b0"}, 
    {t: "200 OK", c: "#6a9955"}, {t: "404 NOT FOUND", c: "#ce9178"},
    {t: "GET /api/data", c: "#569cd6"}, {t: "500 ERROR", c: "#f44336"}
  ];
  
  let time = 0;
  const draw = () => {
    // Gradient background
    const bgGrad = ctx.createLinearGradient(0, 0, w, h);
    bgGrad.addColorStop(0, "rgba(10, 15, 25, 0.8)");
    bgGrad.addColorStop(1, "rgba(20, 10, 30, 0.8)");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);
    
    const centerY = h * 0.5;
    const clientX = w * 0.15; const clientY = centerY;
    const serverX = w * 0.85; const serverY = centerY;
    
    // Draw nodes with glow
    const drawNode = (x: number, y: number, text: string, color: string, isServer: boolean) => {
      const radius = isServer ? 50 : 40;
      
      // Glow
      ctx.shadowColor = color;
      ctx.shadowBlur = 25;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(30, 30, 30, 0.9)";
      ctx.fill();
      ctx.shadowBlur = 0;
      
      // Border
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
      
      // Text
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.font = "bold 12px monospace";
      ctx.fillText(text, x, y + 5);
    };
    
    drawNode(clientX, clientY, "CLIENT", "#4ec9b0", false);
    drawNode(serverX, serverY, "SERVER", "#569cd6", true);
    
    // Draw connection line with animation
    ctx.beginPath();
    ctx.moveTo(clientX + 40, clientY);
    ctx.lineTo(serverX - 50, serverY);
    
    // Animated dashed line
    const dashPhase = (time * 0.1) % 10;
    ctx.strokeStyle = "rgba(100, 200, 255, 0.3)";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.lineDashOffset = -dashPhase;
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Send new requests more slowly - every 40 frames instead of 20
    if (time % 40 === 0 && Math.random() > 0.3) {
      const isReq = Math.random() > 0.4;
      const m = methods[Math.floor(Math.random() * methods.length)];
      requests.push({
        x: isReq ? clientX + 40 : serverX - 50,
        y: isReq ? clientY : serverY,
        targetX: isReq ? serverX - 50 : clientX + 40,
        targetY: isReq ? serverY : clientY,
        progress: 0,
        phase: isReq ? 0 : 0,
        text: m.t,
        color: m.c,
        isResponse: !isReq
      });
    }
    
    // Draw and update requests
    for (let i = requests.length - 1; i >= 0; i--) {
      const r = requests[i];
      // Slower speed - takes 2 seconds instead of 1
      r.progress += 0.005;
      
      if (r.progress < 1) {
        // Ease in/out cubic for smoother motion
        const t = r.progress;
        const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        
        const px = r.x + (r.targetX - r.x) * eased;
        const py = r.y + (r.targetY - r.y) * eased;
        
        // Draw packet box with glow
        ctx.shadowColor = r.color;
        ctx.shadowBlur = 15;
        ctx.fillStyle = r.color;
        const textWidth = ctx.measureText(r.text).width + 20;
        ctx.beginPath();
        ctx.roundRect(px - textWidth / 2, py - 12, textWidth, 24, [6]);
        ctx.fill();
        ctx.shadowBlur = 0;
        
        // Draw text
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.font = "11px monospace";
        ctx.fillText(r.text, px, py + 4);
        
        // Draw direction indicator
        ctx.fillStyle = r.color;
        const arrowX = r.isResponse ? px - textWidth / 2 - 8 : px + textWidth / 2 + 8;
        const arrowY = py;
        ctx.beginPath();
        if (r.isResponse) {
          ctx.moveTo(arrowX + 5, arrowY - 4);
          ctx.lineTo(arrowX, arrowY);
          ctx.lineTo(arrowX + 5, arrowY + 4);
        } else {
          ctx.moveTo(arrowX - 5, arrowY - 4);
          ctx.lineTo(arrowX, arrowY);
          ctx.lineTo(arrowX - 5, arrowY + 4);
        }
        ctx.stroke();
      } else {
        requests.splice(i, 1);
      }
    }
    
    // Draw statistics
    ctx.fillStyle = "rgba(150, 200, 255, 0.7)";
    ctx.textAlign = "left";
    ctx.font = "11px monospace";
    ctx.fillText(`Active Requests: ${requests.length}`, 20, h - 20);
    
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
  let time = 0;
  const groundY = h * 0.72;
  const characters: {x:number, lane:number, speed:number, phase:number, scale:number, color:string}[] = [];
  const colors = ["#1f6feb", "#f97316", "#22c55e", "#eab308"];
  for(let i=0; i<4; i++) {
    characters.push({
      x: Math.random() * w,
      lane: i,
      speed: 0.7 + Math.random() * 0.75,
      phase: Math.random() * Math.PI * 2,
      scale: 0.74 + i * 0.08,
      color: colors[i % colors.length]
    });
  }

  const drawBlock = (x:number, y:number, width:number, height:number, depth:number, color:string) => {
    const shade = "rgba(0, 0, 0, 0.18)";
    ctx.fillStyle = color;
    ctx.fillRect(x - width / 2, y - height, width, height);
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.moveTo(x + width / 2, y - height);
    ctx.lineTo(x + width / 2 + depth, y - height - depth * 0.45);
    ctx.lineTo(x + width / 2 + depth, y - depth * 0.45);
    ctx.lineTo(x + width / 2, y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
    ctx.beginPath();
    ctx.moveTo(x - width / 2, y - height);
    ctx.lineTo(x - width / 2 + depth, y - height - depth * 0.45);
    ctx.lineTo(x + width / 2 + depth, y - height - depth * 0.45);
    ctx.lineTo(x + width / 2, y - height);
    ctx.closePath();
    ctx.fill();
  };

  const drawAvatar = (x:number, y:number, scale:number, phase:number, shirt:string) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    const step = Math.sin(phase);
    const bob = Math.abs(step) * 4;
    ctx.translate(0, -bob);

    ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
    ctx.beginPath();
    ctx.ellipse(0, 62 + bob, 38, 10, 0, 0, Math.PI * 2);
    ctx.fill();

    const skin = "#f2c94c";
    drawBlock(0, -18, 42, 48, 7, shirt);
    drawBlock(-29, -12 + step * 5, 13, 43, 5, skin);
    drawBlock(29, -12 - step * 5, 13, 43, 5, skin);
    drawBlock(-13, 52 - step * 6, 15, 44, 5, "#2f855a");
    drawBlock(13, 52 + step * 6, 15, 44, 5, "#2f855a");
    drawBlock(0, -66, 34, 30, 6, skin);

    ctx.fillStyle = "#171717";
    ctx.fillRect(-8, -56, 4, 4);
    ctx.fillRect(6, -56, 4, 4);
    ctx.fillRect(-8, -47, 16, 2);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(-17, -66, 34, 5);
    ctx.restore();
  };

  const draw = () => {
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#78b7ff");
    sky.addColorStop(0.58, "#cfeaff");
    sky.addColorStop(0.59, "#6bbf59");
    sky.addColorStop(1, "#2f7d3f");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
    for (let i = 0; i < 5; i++) {
      const x = ((time * 0.12 + i * 220) % (w + 220)) - 110;
      const y = 70 + i % 2 * 42;
      ctx.beginPath();
      ctx.ellipse(x, y, 54, 14, 0, 0, Math.PI * 2);
      ctx.ellipse(x + 36, y + 4, 36, 12, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = "rgba(70, 90, 70, 0.24)";
    for (let gx = -80; gx < w + 120; gx += 80) {
      ctx.beginPath();
      ctx.moveTo(gx, groundY);
      ctx.lineTo(gx + 140, h);
      ctx.strokeStyle = "rgba(255,255,255,0.16)";
      ctx.stroke();
    }

    for (const c of characters) {
      c.x += c.speed;
      c.phase += 0.085 * c.speed;
      const y = groundY + c.lane * 26;
      if (c.x > w + 70) c.x = -70;
      drawAvatar(c.x, y, c.scale, c.phase, c.color);
    }
    time++;
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
  let time = 0;
  const floorY = h * 0.78;
  const balls: {x:number, y:number, vx:number, vy:number, r:number, rot:number, vrot:number, squash:number}[] = [];
  for(let i=0; i<7; i++) {
    balls.push({
      x: Math.random()*w, y: floorY - 100 - Math.random() * 260, r: 24 + Math.random() * 8,
      vx: (Math.random()-0.5)*3.4, vy: Math.random() * -4,
      rot: 0, vrot: 0, squash: 0
    });
  }

  const draw = () => {
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#86c8ff");
    sky.addColorStop(0.62, "#d8f1ff");
    sky.addColorStop(0.63, "#6abf69");
    sky.addColorStop(1, "#347b38");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = "rgba(30, 90, 35, 0.22)";
    for (let i = 0; i < 80; i++) {
      const x = (i * 47 + time * 0.2) % w;
      const y = floorY + ((i * 29) % Math.max(1, h - floorY));
      ctx.fillRect(x, y, 2, 10 + (i % 5));
    }
    
    for(const b of balls) {
      b.vy += 0.18;
      b.x += b.vx;
      b.y += b.vy;
      b.vx *= 0.997;
      b.vrot = b.vx / Math.max(1, b.r);
      b.rot += b.vrot;

      if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx) * 0.84; }
      if (b.x > w-b.r) { b.x = w - b.r; b.vx = -Math.abs(b.vx) * 0.84; }
      if (b.y > floorY - b.r) {
        b.y = floorY - b.r;
        b.vy = -Math.abs(b.vy) * 0.72;
        b.vx *= 0.92;
        b.squash = Math.min(0.22, Math.abs(b.vy) * 0.018);
      }
      b.squash *= 0.82;
      
      ctx.fillStyle = `rgba(0,0,0,${0.18 + Math.min(0.2, b.y / h * 0.18)})`;
      ctx.beginPath();
      ctx.ellipse(b.x, floorY + 4, b.r * 0.9, b.r * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.save(); 
      ctx.translate(b.x, b.y); 
      ctx.scale(1 + b.squash, 1 - b.squash);
      ctx.rotate(b.rot);
      
      ctx.fillStyle = "#ee1515";
      ctx.beginPath(); ctx.arc(0, 0, b.r, Math.PI, Math.PI*2); ctx.fill();
      const redGrad = ctx.createLinearGradient(-b.r, -b.r, b.r, 0);
      redGrad.addColorStop(0, "rgba(120, 0, 0, 0.18)");
      redGrad.addColorStop(0.35, "rgba(255, 255, 255, 0.16)");
      redGrad.addColorStop(1, "rgba(0, 0, 0, 0.2)");
      ctx.fillStyle = redGrad;
      ctx.beginPath(); ctx.arc(0, 0, b.r, Math.PI, Math.PI*2); ctx.fill();
      ctx.fillStyle = "#f7f7f2";
      ctx.beginPath(); ctx.arc(0, 0, b.r, 0, Math.PI); ctx.fill();
      ctx.fillStyle = "#222";
      ctx.fillRect(-b.r, -3, b.r*2, 6);
      ctx.beginPath(); ctx.arc(0, 0, 8, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = "#f8f8f8";
      ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = "rgba(255, 255, 255, 0.48)";
      ctx.beginPath(); ctx.ellipse(-b.r * 0.34, -b.r * 0.38, b.r * 0.18, b.r * 0.08, -0.55, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#222"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, b.r, 0, Math.PI*2); ctx.stroke();
      
      ctx.restore();
    }
    
    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) {
        const a = balls[i], b = balls[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.max(1, Math.hypot(dx, dy));
        const min = a.r + b.r;
        if (dist < min) {
          const nx = dx / dist, ny = dy / dist;
          const push = (min - dist) * 0.5;
          a.x -= nx * push; a.y -= ny * push;
          b.x += nx * push; b.y += ny * push;
          const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (rel < 0) {
            const impulse = rel * -0.82;
            a.vx -= impulse * nx; a.vy -= impulse * ny;
            b.vx += impulse * nx; b.vy += impulse * ny;
          }
        }
      }
    }

    time++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateSupernova(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  let time = 0;
  const cycleLength = 720;
  const particles: {x:number, y:number, vx:number, vy:number, size:number, life:number, hue:number, kind:number}[] = [];
  const shells: {radius:number, speed:number, life:number, hue:number}[] = [];
  const stars = Array.from({ length: Math.min(220, Math.floor(w * h / 6200)) }, (_, i) => ({
    x: (((Math.sin(i * 91.7) * 10000) % 1 + 1) % 1) * w,
    y: (((Math.cos(i * 37.3) * 10000) % 1 + 1) % 1) * h,
    r: 0.35 + (((Math.sin(i * 12.9) * 10000) % 1 + 1) % 1) * 1.1,
    twinkle: i * 0.33
  }));
  
  const draw = () => {
    const bgGrad = ctx.createLinearGradient(0, 0, w, h);
    bgGrad.addColorStop(0, "#03020d");
    bgGrad.addColorStop(0.55, "#080413");
    bgGrad.addColorStop(1, "#01030a");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    for (const s of stars) {
      ctx.fillStyle = `rgba(210, 225, 255, ${0.26 + 0.35 * Math.abs(Math.sin(time * 0.01 + s.twinkle))})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    const centerX = w * 0.5;
    const centerY = h * 0.5;
    const phaseFrame = time % cycleLength;
    const collapse = Math.min(1, phaseFrame / 210);
    const exploded = phaseFrame >= 210;
    const afterGlow = exploded ? Math.max(0, 1 - (phaseFrame - 210) / 510) : 0;
    const prePulse = !exploded ? 0.35 + Math.pow(collapse, 4) * 1.3 + Math.sin(time * 0.17) * collapse * 0.22 : 0;
    
    if (phaseFrame === 210) {
      for (let i = 0; i < 380; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 1.4 + Math.pow(Math.random(), 0.42) * 8.5;
        particles.push({
          x: centerX,
          y: centerY,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          size: 0.9 + Math.random() * 4.5,
          life: 1,
          hue: Math.random() < 0.22 ? 205 + Math.random() * 38 : 18 + Math.random() * 46,
          kind: Math.random()
        });
      }
      shells.push({ radius: 0, speed: Math.min(w, h) * 0.018, life: 1, hue: 36 });
      shells.push({ radius: 0, speed: Math.min(w, h) * 0.012, life: 1, hue: 210 });
    }
    
    ctx.globalCompositeOperation = "lighter";
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= p.kind < 0.18 ? 0.0038 : 0.0068;
      p.vx *= 0.994;
      p.vy *= 0.994;
      p.vy += (p.kind < 0.18 ? 0.006 : 0);
      
      if (p.life > 0) {
        ctx.fillStyle = `hsla(${p.hue}, 100%, ${50 + p.life * 30}%, ${p.life * 0.78})`;
        ctx.shadowColor = `hsla(${p.hue}, 100%, 65%, 0.75)`;
        ctx.shadowBlur = 10 + p.life * 10;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      } else {
        particles.splice(i, 1);
      }
    }
    
    ctx.globalCompositeOperation = "source-over";
    ctx.save();
    ctx.translate(centerX, centerY);
    
    const coreRadius = exploded ? 28 + afterGlow * 70 : 110 - collapse * 72;
    const coreGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, coreRadius);
    coreGrad.addColorStop(0, `rgba(255, 255, 230, ${exploded ? 0.3 + afterGlow * 0.58 : prePulse})`);
    coreGrad.addColorStop(0.28, `rgba(255, 140, 60, ${exploded ? afterGlow * 0.5 : 0.2 + collapse * 0.46})`);
    coreGrad.addColorStop(1, "rgba(255, 50, 0, 0)");
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(0, 0, coreRadius, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.restore();
    
    for (let i = shells.length - 1; i >= 0; i--) {
      const shell = shells[i];
      shell.radius += shell.speed;
      shell.life -= 0.006;
      
      if (shell.life > 0) {
        ctx.beginPath();
        ctx.arc(centerX, centerY, shell.radius, 0, Math.PI * 2);
        ctx.strokeStyle = `hsla(${shell.hue}, 100%, 65%, ${shell.life * 0.48})`;
        ctx.lineWidth = 7 * shell.life;
        ctx.stroke();
      } else {
        shells.splice(i, 1);
      }
    }
    
    time++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateComet(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  let time = 0;
  const stars = Array.from({ length: Math.min(240, Math.floor(w * h / 5200)) }, (_, i) => ({
    x: (((Math.sin(i * 77.13) * 10000) % 1 + 1) % 1) * w,
    y: (((Math.cos(i * 19.91) * 10000) % 1 + 1) % 1) * h,
    r: 0.3 + (((Math.sin(i * 43.1) * 10000) % 1 + 1) % 1) * 1.2,
    twinkle: i * 0.41
  }));
  const dust: {offset:number, spread:number, alpha:number, size:number}[] = Array.from({ length: 90 }, () => ({
    offset: Math.random(),
    spread: (Math.random() - 0.5),
    alpha: 0.25 + Math.random() * 0.45,
    size: 0.7 + Math.random() * 2.4
  }));
  const fragments: {x:number, y:number, vx:number, vy:number, life:number, size:number}[] = [];
  let cometX = -w * 0.18;
  let cometY = h * 0.62;
  const angle = -0.28;
  const speed = Math.max(1.2, Math.min(w, h) * 0.0022);
  const vx = Math.cos(angle) * speed;
  const vy = Math.sin(angle) * speed;
  
  const draw = () => {
    const bgGrad = ctx.createLinearGradient(0, 0, w, h);
    bgGrad.addColorStop(0, "#010414");
    bgGrad.addColorStop(0.52, "#05102a");
    bgGrad.addColorStop(1, "#12091d");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);
    
    for (const s of stars) {
      ctx.fillStyle = `rgba(225, 235, 255, ${0.25 + 0.45 * Math.abs(Math.sin(time * 0.012 + s.twinkle))})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    cometX += vx;
    cometY += vy + Math.sin(time * 0.01) * 0.03;
    if (cometX > w + 220 || cometY < -160) {
      cometX = -w * 0.18;
      cometY = h * (0.58 + Math.random() * 0.16);
      fragments.length = 0;
    }

    const tailAngle = Math.atan2(vy, vx) + Math.PI;
    const tx = Math.cos(tailAngle);
    const ty = Math.sin(tailAngle);
    const nx = -ty;
    const ny = tx;
    const tailLength = Math.min(w, h) * 0.72;

    ctx.globalCompositeOperation = "lighter";
    for (const d of dust) {
      const wave = Math.sin(time * 0.018 + d.offset * 18) * 0.26;
      const distance = d.offset * tailLength;
      const spread = (d.spread + wave) * distance * 0.16;
      const x = cometX + tx * distance + nx * spread;
      const y = cometY + ty * distance + ny * spread;
      const alpha = d.alpha * Math.pow(1 - d.offset, 1.7);
      ctx.fillStyle = `rgba(255, 220, 150, ${alpha * 0.34})`;
      ctx.beginPath();
      ctx.arc(x, y, d.size * (1 + d.offset * 2.4), 0, Math.PI * 2);
      ctx.fill();
    }

    const ionGrad = ctx.createLinearGradient(cometX, cometY, cometX + tx * tailLength * 1.08, cometY + ty * tailLength * 1.08);
    ionGrad.addColorStop(0, "rgba(130, 220, 255, 0.52)");
    ionGrad.addColorStop(0.42, "rgba(95, 170, 255, 0.18)");
    ionGrad.addColorStop(1, "rgba(95, 170, 255, 0)");
    ctx.strokeStyle = ionGrad;
    ctx.lineWidth = Math.max(10, Math.min(w, h) * 0.018);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cometX, cometY);
    ctx.bezierCurveTo(
      cometX + tx * tailLength * 0.32 + nx * 12,
      cometY + ty * tailLength * 0.32 + ny * 12,
      cometX + tx * tailLength * 0.72 - nx * 18,
      cometY + ty * tailLength * 0.72 - ny * 18,
      cometX + tx * tailLength,
      cometY + ty * tailLength
    );
    ctx.stroke();

    const dustGrad = ctx.createRadialGradient(cometX, cometY, 0, cometX + tx * tailLength * 0.32, cometY + ty * tailLength * 0.32, tailLength * 0.5);
    dustGrad.addColorStop(0, "rgba(255, 244, 210, 0.48)");
    dustGrad.addColorStop(0.22, "rgba(255, 191, 112, 0.2)");
    dustGrad.addColorStop(1, "rgba(255, 191, 112, 0)");
    ctx.fillStyle = dustGrad;
    ctx.beginPath();
    ctx.ellipse(cometX + tx * tailLength * 0.2, cometY + ty * tailLength * 0.2, tailLength * 0.46, tailLength * 0.1, tailAngle, 0, Math.PI * 2);
    ctx.fill();

    if (time % 9 === 0 && fragments.length < 28) {
      fragments.push({
        x: cometX + tx * 16 + (Math.random() - 0.5) * 10,
        y: cometY + ty * 16 + (Math.random() - 0.5) * 10,
        vx: tx * (0.5 + Math.random() * 1.6) + nx * (Math.random() - 0.5) * 0.7,
        vy: ty * (0.5 + Math.random() * 1.6) + ny * (Math.random() - 0.5) * 0.7,
        life: 1,
        size: 1 + Math.random() * 2.5
      });
    }
    for (let i = fragments.length - 1; i >= 0; i--) {
      const f = fragments[i];
      f.x += f.vx;
      f.y += f.vy;
      f.life -= 0.012;
      if (f.life <= 0) {
        fragments.splice(i, 1);
        continue;
      }
      ctx.fillStyle = `rgba(255, 232, 180, ${f.life * 0.6})`;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";

    const coma = Math.max(36, Math.min(w, h) * 0.072);
    const comaGrad = ctx.createRadialGradient(cometX, cometY, 0, cometX, cometY, coma);
    comaGrad.addColorStop(0, "rgba(255, 255, 255, 0.96)");
    comaGrad.addColorStop(0.28, "rgba(176, 232, 255, 0.56)");
    comaGrad.addColorStop(1, "rgba(176, 232, 255, 0)");
    ctx.fillStyle = comaGrad;
    ctx.beginPath();
    ctx.arc(cometX, cometY, coma, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(cometX, cometY);
    ctx.rotate(angle);
    const nucleusR = Math.max(11, Math.min(w, h) * 0.018);
    const nucleusGrad = ctx.createRadialGradient(-nucleusR * 0.35, -nucleusR * 0.35, 0, 0, 0, nucleusR * 1.2);
    nucleusGrad.addColorStop(0, "#f8fbff");
    nucleusGrad.addColorStop(0.42, "#9fd4e9");
    nucleusGrad.addColorStop(1, "#3d6479");
    ctx.fillStyle = nucleusGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, nucleusR * 1.28, nucleusR * 0.92, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(30, 61, 83, 0.25)";
    ctx.beginPath(); ctx.arc(nucleusR * 0.28, nucleusR * 0.06, nucleusR * 0.22, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(-nucleusR * 0.18, nucleusR * 0.22, nucleusR * 0.14, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    
    time++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateMeteor(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  let time = 0;
  const meteors: {x:number, y:number, vx:number, vy:number, size:number, life:number, burn:number, trail:{x:number, y:number}[]}[] = [];
  const stars = Array.from({ length: Math.min(220, Math.floor(w * h / 5800)) }, (_, i) => ({
    x: (((Math.sin(i * 69.7) * 10000) % 1 + 1) % 1) * w,
    y: (((Math.cos(i * 25.4) * 10000) % 1 + 1) % 1) * h * 0.82,
    r: 0.3 + (((Math.sin(i * 18.6) * 10000) % 1 + 1) % 1) * 1.1,
    twinkle: i * 0.29
  }));
  
  const draw = () => {
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, "#020512");
    bgGrad.addColorStop(0.58, "#07142b");
    bgGrad.addColorStop(1, "#21110d");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    for (const s of stars) {
      ctx.fillStyle = `rgba(225, 235, 255, ${0.22 + 0.42 * Math.abs(Math.sin(time * 0.012 + s.twinkle))})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    const horizon = ctx.createRadialGradient(w * 0.5, h * 1.05, 0, w * 0.5, h * 1.05, h * 0.55);
    horizon.addColorStop(0, "rgba(255, 128, 54, 0.26)");
    horizon.addColorStop(1, "rgba(255, 128, 54, 0)");
    ctx.fillStyle = horizon;
    ctx.fillRect(0, h * 0.45, w, h * 0.55);
    
    if (time % 42 === 0 && meteors.length < 14) {
      const shower = Math.random() < 0.16 ? 3 : 1;
      for (let i = 0; i < shower; i++) {
        const angle = Math.PI / 4.9 + (Math.random() - 0.5) * 0.13;
        const speed = 7.5 + Math.random() * 5.2;
        meteors.push({
          x: Math.random() * w * 0.82 - w * 0.16,
          y: -40 - Math.random() * 160,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          size: 1.6 + Math.random() * 2.8,
          life: 1,
          burn: 0.35 + Math.random() * 0.65,
          trail: []
        });
      }
    }
    
    for (let i = meteors.length - 1; i >= 0; i--) {
      const m = meteors[i];
      m.trail.push({ x: m.x, y: m.y });
      if (m.trail.length > 30) m.trail.shift();

      m.x += m.vx;
      m.y += m.vy;
      m.vy += 0.018;
      m.vx *= 0.9985;
      m.life -= 0.0052 + m.burn * 0.001;
      
      if (m.life > 0 && m.y < h + 80 && m.x < w + 120) {
        if (m.trail.length > 1) {
          const first = m.trail[0];
          const trailGrad = ctx.createLinearGradient(first.x, first.y, m.x, m.y);
          trailGrad.addColorStop(0, "rgba(255, 200, 90, 0)");
          trailGrad.addColorStop(0.65, `rgba(255, 140, 40, ${m.life * 0.34})`);
          trailGrad.addColorStop(1, `rgba(255, 245, 185, ${m.life * 0.9})`);
          ctx.strokeStyle = trailGrad;
          ctx.lineWidth = m.size * 1.3;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(first.x, first.y);
          for (const t of m.trail) ctx.lineTo(t.x, t.y);
          ctx.stroke();
          ctx.lineCap = "butt";
        }

        if (Math.random() < 0.08 && m.life > 0.35) {
          ctx.fillStyle = `rgba(255, 125, 40, ${m.life * 0.55})`;
          ctx.beginPath();
          ctx.arc(m.x - m.vx * 2 + (Math.random() - 0.5) * 12, m.y - m.vy * 2 + (Math.random() - 0.5) * 12, Math.random() * 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
        
        ctx.fillStyle = `rgba(255, 226, 160, ${m.life})`;
        ctx.shadowColor = `rgba(255, 150, 0, ${m.life * 0.8})`;
        ctx.shadowBlur = 24;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      } else {
        meteors.splice(i, 1);
      }
    }
    
    time++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateSharingan(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  let time = 0;
  const eyes: {x:number, y:number, angle:number}[] = [];
  
  for (let i = 0; i < 5; i++) {
    eyes.push({
      x: w * (0.15 + i * 0.17),
      y: h * 0.5,
      angle: 0
    });
  }
  
  const draw = () => {
    // Dark background
    ctx.fillStyle = "rgba(10, 10, 15, 0.95)";
    ctx.fillRect(0, 0, w, h);
    
    // Draw eyes
    for (const eye of eyes) {
      eye.angle += 0.05;
      
      ctx.save();
      ctx.translate(eye.x, eye.y);
      
      // Outer iris circle
      const irisGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, 50);
      irisGrad.addColorStop(0, "rgba(200, 50, 50, 0.9)");
      irisGrad.addColorStop(0.6, "rgba(150, 30, 30, 0.8)");
      irisGrad.addColorStop(1, "rgba(50, 10, 10, 0.6)");
      ctx.fillStyle = irisGrad;
      ctx.beginPath();
      ctx.arc(0, 0, 50, 0, Math.PI * 2);
      ctx.fill();
      
      // Tomoe (3-pointed stars)
      ctx.rotate(eye.angle);
      for (let i = 0; i < 3; i++) {
        const angle = (Math.PI * 2 / 3) * i;
        const x = Math.cos(angle) * 25;
        const y = Math.sin(angle) * 25;
        
        // Draw comma/droplet shape
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle + Math.PI / 2);
        
        ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
        ctx.beginPath();
        ctx.arc(0, 0, 12, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.fillStyle = "rgba(200, 50, 50, 0.6)";
        ctx.beginPath();
        ctx.arc(0, -8, 6, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.restore();
      }
      
      // Inner pupil
      ctx.fillStyle = "rgba(0, 0, 0, 1)";
      ctx.beginPath();
      ctx.arc(0, 0, 15, 0, Math.PI * 2);
      ctx.fill();
      
      // Pupil glow
      const pupilGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, 15);
      pupilGrad.addColorStop(0, "rgba(255, 100, 100, 0.3)");
      pupilGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = pupilGrad;
      ctx.beginPath();
      ctx.arc(0, 0, 15, 0, Math.PI * 2);
      ctx.fill();
      
      // Outer ring glow
      ctx.strokeStyle = "rgba(200, 50, 50, 0.5)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 50, 0, Math.PI * 2);
      ctx.stroke();
      
      ctx.restore();
    }
    
    time++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

function animateRinnegan(w: number, h: number, ctx: CanvasRenderingContext2D, isActive: () => boolean, setAnim: (id: number) => void) {
  let time = 0;
  const eyes: {x:number, y:number, rotation:number}[] = [];
  
  for (let i = 0; i < 5; i++) {
    eyes.push({
      x: w * (0.15 + i * 0.17),
      y: h * 0.5,
      rotation: 0
    });
  }
  
  const draw = () => {
    // Dark background
    ctx.fillStyle = "rgba(10, 10, 15, 0.95)";
    ctx.fillRect(0, 0, w, h);
    
    // Draw eyes
    for (const eye of eyes) {
      eye.rotation += 0.02;
      
      ctx.save();
      ctx.translate(eye.x, eye.y);
      ctx.rotate(eye.rotation);
      
      // Outer iris circle with gradient
      const irisGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, 50);
      irisGrad.addColorStop(0, "rgba(150, 150, 255, 0.9)");
      irisGrad.addColorStop(0.6, "rgba(100, 100, 200, 0.8)");
      irisGrad.addColorStop(1, "rgba(50, 50, 100, 0.6)");
      ctx.fillStyle = irisGrad;
      ctx.beginPath();
      ctx.arc(0, 0, 50, 0, Math.PI * 2);
      ctx.fill();
      
      // Concentric rings
      for (let ring = 1; ring <= 3; ring++) {
        ctx.strokeStyle = `rgba(150, 150, 255, ${(1 - ring * 0.25) * 0.5})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, 50 - ring * 12, 0, Math.PI * 2);
        ctx.stroke();
      }
      
      // Center dots arranged in circle
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI * 2 / 6) * i;
        const x = Math.cos(angle) * 25;
        const y = Math.sin(angle) * 25;
        
        ctx.fillStyle = "rgba(150, 150, 255, 0.7)";
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.fillStyle = "rgba(255, 200, 100, 0.4)";
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      
      // Inner pupil
      ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
      ctx.beginPath();
      ctx.arc(0, 0, 12, 0, Math.PI * 2);
      ctx.fill();
      
      // Center glow
      const centerGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, 12);
      centerGrad.addColorStop(0, "rgba(255, 200, 100, 0.6)");
      centerGrad.addColorStop(1, "rgba(150, 150, 255, 0)");
      ctx.fillStyle = centerGrad;
      ctx.beginPath();
      ctx.arc(0, 0, 12, 0, Math.PI * 2);
      ctx.fill();
      
      // Outer ring glow
      ctx.shadowColor = "rgba(150, 150, 255, 0.8)";
      ctx.shadowBlur = 25;
      ctx.strokeStyle = "rgba(150, 150, 255, 0.6)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 50, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
      
      ctx.restore();
    }
    
    time++;
    if (isActive()) setAnim(requestAnimationFrame(draw));
  };
  draw();
}

// Welcome page: GSAP entrance animations + particle canvas + filter

// GSAP is loaded via CDN script tag
declare const gsap: {
  timeline(opts?: Record<string, unknown>): GSAPTimeline;
  fromTo(targets: string | Element | NodeList, from: Record<string, unknown>, to: Record<string, unknown>): GSAPTween;
  to(targets: string | Element | NodeList, vars: Record<string, unknown>): GSAPTween;
};
interface GSAPTimeline {
  fromTo(targets: string | Element | NodeList, from: Record<string, unknown>, to: Record<string, unknown>, position?: string): this;
}
interface GSAPTween { /* opaque */ }

// ── Particle Canvas ──────────────────────────────────────────────────────────

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  alpha: number;
  pulse: number;
  pulseSpeed: number;
}

function initParticles(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")!;
  let W = 0, H = 0;
  const particles: Particle[] = [];
  const COUNT = 55;
  let raf: number;

  function resize() {
    W = canvas.width = canvas.offsetWidth;
    H = canvas.height = canvas.offsetHeight;
  }

  function spawn(): Particle {
    return {
      x: Math.random() * W,
      y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.18,
      vy: (Math.random() - 0.5) * 0.18,
      r: Math.random() * 1.4 + 0.4,
      alpha: Math.random() * 0.45 + 0.1,
      pulse: Math.random() * Math.PI * 2,
      pulseSpeed: 0.008 + Math.random() * 0.012,
    };
  }

  resize();
  for (let i = 0; i < COUNT; i++) particles.push(spawn());

  function draw() {
    ctx.clearRect(0, 0, W, H);

    // Draw connection lines
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 110) {
          ctx.beginPath();
          ctx.strokeStyle = `rgba(0,140,255,${0.06 * (1 - dist / 110)})`;
          ctx.lineWidth = 0.6;
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.stroke();
        }
      }
    }

    // Draw particles
    for (const p of particles) {
      p.pulse += p.pulseSpeed;
      const alpha = p.alpha * (0.7 + 0.3 * Math.sin(p.pulse));
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(100,180,255,${alpha})`;
      ctx.fill();

      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0) p.x = W;
      if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H;
      if (p.y > H) p.y = 0;
    }

    raf = requestAnimationFrame(draw);
  }

  const ro = new ResizeObserver(resize);
  ro.observe(canvas.parentElement!);

  draw();

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
  };
}

// ── Badge helper ─────────────────────────────────────────────────────────────

function detectBadge(name: string, path: string): { cls: string; label: string } {
  const lower = (name + path).toLowerCase();
  if (lower.includes("react")) return { cls: "badge-react", label: "REACT" };
  if (lower.includes(".ts") || lower.includes("typescript") || lower.includes("-ts")) return { cls: "badge-ts", label: "TS" };
  if (lower.includes("python") || lower.includes(".py")) return { cls: "badge-py", label: "PY" };
  if (lower.includes("rust") || lower.includes(".rs")) return { cls: "badge-rs", label: "RS" };
  if (lower.includes("golang") || lower.includes("-go")) return { cls: "badge-go", label: "GO" };
  if (lower.includes(".js") || lower.includes("javascript") || lower.includes("express") || lower.includes("node")) return { cls: "badge-js", label: "JS" };
  return { cls: "badge-dir", label: "DIR" };
}

// ── Time helper ───────────────────────────────────────────────────────────────

function relativeTime(ts: number): string {
  const diff = Date.now() - ts * 1000;
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

// ── Enhanced renderRecentProjects ────────────────────────────────────────────

export function buildRecentItem(p: { name: string; path: string; last_opened: number }, starred: Set<string>): string {
  const badge = detectBadge(p.name, p.path);
  const isStarred = starred.has(p.path);
  const time = relativeTime(p.last_opened);

  return `
    <div class="recent-item" data-path="${escapeHtmlAnim(p.path)}">
      <span class="recent-item-badge ${badge.cls}">${badge.label}</span>
      <div class="recent-item-info">
        <span class="recent-item-name">${escapeHtmlAnim(p.name)}</span>
        <span class="recent-item-path">${escapeHtmlAnim(p.path)}</span>
      </div>
      <div class="recent-item-right">
        <span class="recent-item-time">${time}</span>
        <button class="recent-item-star${isStarred ? " starred" : ""}" data-star="${escapeHtmlAnim(p.path)}" title="Star project" aria-label="Star project">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z"/></svg>
        </button>
        <button class="recent-item-remove" data-remove="${escapeHtmlAnim(p.path)}" title="Remove from recent" aria-label="Remove from recent">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>
        </button>
      </div>
    </div>
  `;
}

function escapeHtmlAnim(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── GSAP entrance animations ─────────────────────────────────────────────────

function animateIn() {
  if (typeof gsap === "undefined") return;
  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReduced) {
    const c = document.querySelector(".welcome-container") as HTMLElement;
    if (c) { c.style.opacity = "1"; }
    return;
  }

  const tl = gsap.timeline({ defaults: { ease: "power3.out" } });

  tl.fromTo(".welcome-container", { opacity: 0 }, { opacity: 1, duration: 0.01 })
    .fromTo(
      "#brand-block",
      { opacity: 0, y: 28, filter: "blur(6px)" },
      { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.65 }
    )
    .fromTo(
      "#start-section",
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.5 },
      "-=0.35"
    )
    .fromTo(
      "#quick-access-section",
      { opacity: 0, y: 16 },
      { opacity: 1, y: 0, duration: 0.45 },
      "-=0.3"
    )
    .fromTo(
      "#welcome-right-block",
      { opacity: 0, x: 24 },
      { opacity: 1, x: 0, duration: 0.55 },
      "-=0.5"
    )
    .fromTo(
      ".recent-item",
      { opacity: 0, x: 16 },
      { opacity: 1, x: 0, duration: 0.35, stagger: 0.055 },
      "-=0.3"
    );
}

// ── 3D tilt on brand icon ────────────────────────────────────────────────────

function initTilt() {
  const icon = document.querySelector(".brand-icon-wrap") as HTMLElement | null;
  if (!icon || typeof gsap === "undefined") return;

  icon.addEventListener("mousemove", (e) => {
    const rect = icon.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = (e.clientX - cx) / (rect.width / 2);
    const dy = (e.clientY - cy) / (rect.height / 2);
    gsap.to(icon, {
      rotateY: dx * 18,
      rotateX: -dy * 18,
      scale: 1.06,
      duration: 0.25,
      ease: "power2.out",
      transformPerspective: 400,
    });
  });

  icon.addEventListener("mouseleave", () => {
    gsap.to(icon, { rotateY: 0, rotateX: 0, scale: 1, duration: 0.45, ease: "elastic.out(1, 0.5)" });
  });
}

// ── Filter ───────────────────────────────────────────────────────────────────

function initFilter() {
  const input = document.getElementById("recent-filter-input") as HTMLInputElement | null;
  if (!input) return;

  input.addEventListener("input", () => {
    const q = input.value.toLowerCase().trim();
    document.querySelectorAll<HTMLElement>(".recent-item").forEach((el) => {
      const name = el.querySelector(".recent-item-name")?.textContent?.toLowerCase() ?? "";
      const path = el.querySelector(".recent-item-path")?.textContent?.toLowerCase() ?? "";
      el.style.display = (!q || name.includes(q) || path.includes(q)) ? "" : "none";
    });
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────

function init() {
  const canvas = document.getElementById("welcome-particles") as HTMLCanvasElement | null;
  if (canvas) initParticles(canvas);

  animateIn();
  initTilt();
  initFilter();

  // Re-animate recent items when they're populated
  const listEl = document.getElementById("recent-projects");
  if (listEl) {
    const mo = new MutationObserver(() => {
      if (typeof gsap !== "undefined") {
        const items = listEl.querySelectorAll<HTMLElement>(".recent-item");
        if (items.length > 0) {
          gsap.fromTo(items,
            { opacity: 0, x: 14 },
            { opacity: 1, x: 0, duration: 0.3, stagger: 0.05, ease: "power2.out" }
          );
        }
      }
      initFilter(); // re-bind filter after re-render
    });
    mo.observe(listEl, { childList: true });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

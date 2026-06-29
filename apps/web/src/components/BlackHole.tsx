import { type CSSProperties, useEffect, useRef, useState } from 'react';

import { prefersReducedMotion } from '../utils';

// lib.dom ships the WebGPU interfaces but not this flag constant — declare the
// bits we use; the browser provides them at runtime (same as theme-transition).
declare const GPUBufferUsage: {
  readonly UNIFORM: number;
  readonly COPY_DST: number;
};

// The single frame shown to reduced-motion users (seconds into the animation).
// Picked for a well-formed disk; purely cosmetic, safe to tune.
const STATIC_FRAME_TIME = 6;

// Fullscreen "fall in" dolly: the camera zooms from→to over ZOOM_MS, anchored so the
// hole sits half-off the right edge. Bigger ZOOM_TO = the disk fills more of the
// screen. All three are cosmetic, safe to tune.
const ZOOM_FROM = 0.75;
const ZOOM_TO = 1.25;
const ZOOM_MS = 2000;

/**
 * A plain ring at the event-horizon radius — shown before the shader loads, and the
 * fallback when WebGPU is unavailable or fails. r = HORIZON (0.22) × the 300 viewBox = 66,
 * so it lines up with the shader's photon ring. `currentColor` keeps it visible in both themes.
 */
function PlaceholderRing({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 300 300"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <circle
        cx="150"
        cy="150"
        r="66"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        opacity="0.5"
      />
    </svg>
  );
}

/**
 * The WGSL accretion-disk black hole, on the same WebGPU setup as the theme transition.
 * Inline (default) it's a centred square sized by `className`/`style`, with a ring
 * placeholder/fallback — used for the 404 "0". With `fullscreen` it's a full-bleed fixed
 * canvas anchored half-off the right edge that dollies the camera in (static end-frame
 * under reduced motion) — the no-results search scene. The shader fades in over the
 * ring once ready.
 */
export default function BlackHole({
  className,
  style,
  fullscreen = false,
}: {
  className?: string;
  style?: CSSProperties;
  fullscreen?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Show the placeholder ring first, then swap to the shader on success. The ring stays
  // if WebGPU is unavailable or fails — it's the fallback.
  const [mode, setMode] = useState<'gpu' | 'svg'>('svg');

  useEffect(() => {
    // No WebGPU at all → the ring is the only option. Reduced motion still gets the
    // shader, just frozen on one frame (handled below), so it's not gated here.
    if (!navigator.gpu) {
      setMode('svg');
      return;
    }
    const reduce = prefersReducedMotion();
    const canvas = canvasRef.current;
    if (!canvas) return;
    let device: GPUDevice | undefined;
    let raf = 0;
    let alive = true;
    let visible = true;
    let resize: ResizeObserver | undefined;
    let io: IntersectionObserver | undefined;
    let themeObserver: MutationObserver | undefined;

    /** Resize the drawing buffer to the canvas box. Idempotent — only touches the canvas
     * when the size actually changed, so it can't needlessly clear the static frame. */
    const sizeCanvas = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(2, Math.ceil(rect.width * dpr));
      const h = Math.max(2, Math.ceil(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };

    // Fetch the shader in parallel with GPU acquisition — independent latencies, so the
    // ~7 KB chunk download overlaps adapter/device setup instead of running after it. It
    // stays out of the route chunk until a black hole actually renders on a WebGPU client.
    const wgslPromise = import('../notFound.wgsl?raw').catch(() => null);

    (async () => {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
          setMode('svg');
          return;
        }
        device = await adapter.requestDevice();
      } catch {
        setMode('svg');
        return;
      }
      if (!alive) {
        device?.destroy();
        return;
      }
      const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
      if (!ctx) {
        setMode('svg');
        device.destroy();
        return;
      }
      sizeCanvas();
      const format = navigator.gpu.getPreferredCanvasFormat();

      const wgsl = await wgslPromise;
      if (!alive) {
        device.destroy();
        return;
      }
      if (!wgsl) {
        setMode('svg');
        device.destroy();
        return;
      }
      const WGSL = wgsl.default;

      let pipeline: GPURenderPipeline;
      let uniform: GPUBuffer;
      let bindGroup: GPUBindGroup;
      // Validation errors (e.g. a shader compile failure) surface through the
      // error scope, not as throws — capture them so we keep the SVG fallback.
      device.pushErrorScope('validation');
      try {
        ctx.configure({ device, format, alphaMode: 'premultiplied' });
        const module = device.createShaderModule({ code: WGSL });
        pipeline = device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format }] },
          primitive: { topology: 'triangle-list' },
        });
        uniform = device.createBuffer({
          size: 32, // vec2 resolution, time, dark, vec2 center, zoom, pad
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: uniform } }],
        });
      } catch {
        setMode('svg');
        await device.popErrorScope().catch(() => null);
        device.destroy();
        return;
      }
      // .catch guards against the device being destroyed mid-setup (an unmount between
      // awaits) so popErrorScope can't reject on a dead device.
      const setupError = await device.popErrorScope().catch(() => null);
      if (!alive) {
        device.destroy();
        return;
      }
      if (setupError) {
        if (import.meta.env.DEV) {
          console.warn('[black-hole shader]', setupError.message);
        }
        setMode('svg');
        device.destroy();
        return;
      }

      setMode('gpu');

      // If the GPU device is lost (driver reset, GPU-process crash, tab discard), stop
      // and fall back to the ring rather than hammering a dead device forever.
      void device.lost.then(() => {
        if (!alive) return; // our own destroy() on unmount — already torn down
        alive = false;
        if (raf) window.cancelAnimationFrame(raf);
        setMode('svg');
      });

      /** Camera framing for the current canvas aspect + elapsed time. Inline (404) is
       * always centred at zoom 1; fullscreen anchors the hole off the right edge and
       * dollies the zoom in (or sits at the settled frame under reduced motion). */
      const framing = (elapsedMs: number) => {
        if (!fullscreen) return { cx: 0, cy: 0, zoom: 1 };
        const cx = 0.5 * (canvas.width / canvas.height); // centre at the right edge
        if (reduce) return { cx, cy: 0, zoom: ZOOM_TO };
        const p = Math.min(elapsedMs / ZOOM_MS, 1);
        const eased = 1 - (1 - p) ** 3; // easeOutCubic
        return { cx, cy: 0, zoom: ZOOM_FROM + (ZOOM_TO - ZOOM_FROM) * eased };
      };

      const data = new Float32Array(8);
      /** Render one frame at shader time `t` (seconds) and dolly progress `elapsedMs`.
       * Shared by the animation loop and the reduced-motion static render. */
      const drawFrame = (dev: GPUDevice, t: number, elapsedMs: number) => {
        const { cx, cy, zoom } = framing(elapsedMs);
        data[0] = canvas.width;
        data[1] = canvas.height;
        data[2] = t;
        // Read the live theme each draw so the stars match dark/light.
        data[3] = document.documentElement.classList.contains('dark') ? 1 : 0;
        data[4] = cx;
        data[5] = cy;
        data[6] = zoom;
        dev.queue.writeBuffer(uniform, 0, data);

        const encoder = dev.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: ctx.getCurrentTexture().createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
        dev.queue.submit([encoder.finish()]);
      };

      // Reduced motion: draw one static frame (the settled framing), then redraw only
      // when something that changes its pixels happens — a resize (canvas clears) or a
      // theme toggle (star colour). No rAF loop, no offscreen pausing needed.
      if (reduce) {
        const renderStatic = () => {
          if (alive && device) drawFrame(device, STATIC_FRAME_TIME, ZOOM_MS);
        };
        renderStatic();
        resize = new ResizeObserver(() => {
          sizeCanvas();
          renderStatic();
        });
        resize.observe(canvas);
        themeObserver = new MutationObserver(renderStatic);
        themeObserver.observe(document.documentElement, {
          attributeFilter: ['class'],
        });
        return;
      }

      const start = performance.now();
      const animate = (now: number) => {
        // Stop the loop while unmounted, device-lost, or scrolled offscreen.
        if (!alive || !device || !visible) {
          raf = 0;
          return;
        }
        const elapsed = now - start;
        drawFrame(device, elapsed / 1000, elapsed);
        raf = window.requestAnimationFrame(animate);
      };

      resize = new ResizeObserver(sizeCanvas);
      resize.observe(canvas);
      // Pause the draw loop while the hole is scrolled out of view (tab-hidden is already
      // covered — browsers don't fire rAF for hidden tabs).
      io = new IntersectionObserver(([entry]) => {
        visible = entry?.isIntersecting ?? true;
        if (visible && !raf && alive && device) {
          raf = window.requestAnimationFrame(animate);
        }
      });
      io.observe(canvas);

      raf = window.requestAnimationFrame(animate);
    })();

    return () => {
      alive = false;
      if (raf) window.cancelAnimationFrame(raf);
      resize?.disconnect();
      io?.disconnect();
      themeObserver?.disconnect();
      device?.destroy();
    };
  }, [fullscreen]);

  return (
    <div
      className={
        fullscreen
          ? `pointer-events-none fixed inset-0 ${className ?? ''}`
          : `relative ${className ?? ''}`
      }
      style={fullscreen ? undefined : style}
    >
      {!fullscreen && (
        <PlaceholderRing
          className="absolute inset-0 h-full w-full text-(--sea-ink) transition-opacity duration-500"
          style={{ opacity: mode === 'svg' ? 1 : 0 }}
        />
      )}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="absolute inset-0 h-full w-full transition-opacity duration-500"
        style={{ opacity: mode === 'gpu' ? 1 : 0 }}
      />
    </div>
  );
}

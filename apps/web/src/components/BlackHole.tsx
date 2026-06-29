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
 * A plain ring shows first and stays as the no-WebGPU / failure fallback; otherwise the
 * shader fades in over it — animated normally, or as a single static frame under reduced
 * motion. Size the square box via `className` / `style`. Used for the 404 "0" and the
 * empty-search state.
 */
export default function BlackHole({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
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
          size: 16,
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

      const data = new Float32Array(4);
      /** Render exactly one frame at time `t` (seconds). Shared by the animation loop and
       * the reduced-motion static render. */
      const drawFrame = (dev: GPUDevice, t: number) => {
        data[0] = canvas.width;
        data[1] = canvas.height;
        data[2] = t;
        // Read the live theme each draw so the stars match dark/light.
        data[3] = document.documentElement.classList.contains('dark') ? 1 : 0;
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

      // Reduced motion: draw one static frame, then redraw only when something that
      // changes its pixels happens — a resize (canvas clears) or a theme toggle (star
      // colour). No rAF loop, no offscreen pausing needed.
      if (reduce) {
        const renderStatic = () => {
          if (alive && device) drawFrame(device, STATIC_FRAME_TIME);
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
        drawFrame(device, (now - start) / 1000);
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
  }, []);

  return (
    <div className={`relative ${className ?? ''}`} style={style}>
      <PlaceholderRing
        className="absolute inset-0 h-full w-full text-(--sea-ink) transition-opacity duration-500"
        style={{ opacity: mode === 'svg' ? 1 : 0 }}
      />
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="absolute inset-0 h-full w-full transition-opacity duration-500"
        style={{ opacity: mode === 'gpu' ? 1 : 0 }}
      />
    </div>
  );
}

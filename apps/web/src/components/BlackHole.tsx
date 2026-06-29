import { type CSSProperties, useEffect, useRef, useState } from 'react';

import { prefersReducedMotion } from '../utils';

// lib.dom ships the WebGPU interfaces but not this flag constant — declare the
// bits we use; the browser provides them at runtime (same as theme-transition).
declare const GPUBufferUsage: {
  readonly UNIFORM: number;
  readonly COPY_DST: number;
};

/**
 * A plain ring at the event-horizon radius — shown before the shader loads, and the
 * no-WebGPU / reduced-motion fallback. r = HORIZON (0.22) × the 300 viewBox = 66, so it
 * lines up with the shader's photon ring. `currentColor` keeps it visible in both themes.
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
 * A plain ring shows first (and is the no-WebGPU / reduced-motion fallback); the shader
 * fades in over it once ready. Size the square box via `className` / `style`. Used for
 * the 404 "0" and the empty-search state.
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
    if (prefersReducedMotion() || !navigator.gpu) {
      setMode('svg');
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    let device: GPUDevice | undefined;
    let raf = 0;
    let alive = true;
    let resize: ResizeObserver | undefined;

    /** Resize the drawing buffer to the canvas box; the frame loop reads it into u.resolution. */
    const sizeCanvas = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(2, Math.ceil(rect.width * dpr));
      canvas.height = Math.max(2, Math.ceil(rect.height * dpr));
    };

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

      // Load the shader lazily so its ~7 KB stays out of the route chunk until a black
      // hole actually renders on a WebGPU client.
      let WGSL: string;
      try {
        WGSL = (await import('../notFound.wgsl?raw')).default;
      } catch {
        setMode('svg');
        device.destroy();
        return;
      }

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
      const setupError = await device.popErrorScope();
      if (setupError || !alive) {
        if (setupError && import.meta.env.DEV) {
          console.warn('[black-hole shader]', setupError.message);
        }
        if (setupError) setMode('svg');
        device.destroy();
        return;
      }

      setMode('gpu');
      resize = new ResizeObserver(sizeCanvas);
      resize.observe(canvas);

      const data = new Float32Array(4);
      const start = performance.now();
      const frame = (now: number) => {
        if (!alive || !device) return;
        data[0] = canvas.width;
        data[1] = canvas.height;
        data[2] = (now - start) / 1000;
        // Read the live theme each frame so the stars flip on a theme toggle.
        data[3] = document.documentElement.classList.contains('dark') ? 1 : 0;
        device.queue.writeBuffer(uniform, 0, data);

        const encoder = device.createCommandEncoder();
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
        device.queue.submit([encoder.finish()]);
        raf = window.requestAnimationFrame(frame);
      };
      raf = window.requestAnimationFrame(frame);
    })();

    return () => {
      alive = false;
      if (raf) window.cancelAnimationFrame(raf);
      resize?.disconnect();
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

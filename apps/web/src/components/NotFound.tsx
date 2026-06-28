import { Link } from '@tanstack/react-router';
import { type CSSProperties, useEffect, useRef, useState } from 'react';

import WGSL from '../notFound.wgsl?raw';
import { prefersReducedMotion } from '../utils';

// lib.dom ships the WebGPU interfaces but not this flag constant — declare the
// bits we use; the browser provides them at runtime (same as theme-transition).
declare const GPUBufferUsage: {
  readonly UNIFORM: number;
  readonly COPY_DST: number;
};

/** Static two-tone black hole — the no-WebGPU / reduced-motion fallback for the shader canvas. */
function BlackHoleSvg({
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
      <defs>
        <radialGradient id="bh-bloom" cx="50%" cy="50%" r="50%">
          <stop offset="32%" stopColor="rgba(0,0,0,0)" />
          <stop offset="46%" stopColor="rgba(90,130,255,.20)" />
          <stop offset="58%" stopColor="rgba(255,70,50,.16)" />
          <stop offset="76%" stopColor="rgba(110,90,225,.08)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0)" />
        </radialGradient>
        <linearGradient id="bh-disk" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#11338f" />
          <stop offset="13%" stopColor="#2f6bf0" />
          <stop offset="30%" stopColor="#8fbaff" />
          <stop offset="50%" stopColor="#ffffff" />
          <stop offset="71%" stopColor="#ff6a33" />
          <stop offset="86%" stopColor="#e22b22" />
          <stop offset="100%" stopColor="#8e0f1e" />
        </linearGradient>
        <filter id="bh-swirl" x="-50%" y="-50%" width="200%" height="200%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.007 0.012"
            numOctaves="2"
            seed="14"
            result="n"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="n"
            scale="28"
            xChannelSelector="R"
            yChannelSelector="G"
          />
          <feGaussianBlur stdDeviation="0.8" />
        </filter>
        <filter id="bh-soft" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
      </defs>
      <circle cx="150" cy="150" r="150" fill="url(#bh-bloom)" />
      <g filter="url(#bh-swirl)">
        <circle
          cx="150"
          cy="150"
          r="90"
          fill="none"
          stroke="url(#bh-disk)"
          strokeWidth="40"
        />
      </g>
      <path
        d="M64,152 A86,86 0 0 1 236,152"
        fill="none"
        stroke="url(#bh-disk)"
        strokeWidth="9"
        opacity="0.95"
        filter="url(#bh-soft)"
      />
      <circle cx="150" cy="150" r="64" fill="#000" />
      <circle
        cx="150"
        cy="150"
        r="63"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        opacity="0.9"
        filter="url(#bh-soft)"
      />
    </svg>
  );
}

/**
 * 404 page: the error code reads "4 ● 4" with a black hole as the zero. The hole
 * is a WGSL accretion-disk shader driven by the same WebGPU setup as the theme
 * transition; where WebGPU is unavailable or motion is reduced, a static SVG
 * black hole renders in its place.
 */
export default function NotFound() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [gpuActive, setGpuActive] = useState(false);

  useEffect(() => {
    if (prefersReducedMotion() || !navigator.gpu) return;
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
        if (!adapter) return;
        device = await adapter.requestDevice();
      } catch {
        return;
      }
      if (!alive) {
        device?.destroy();
        return;
      }
      const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
      if (!ctx) {
        device.destroy();
        return;
      }
      sizeCanvas();
      const format = navigator.gpu.getPreferredCanvasFormat();

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
        await device.popErrorScope().catch(() => null);
        device.destroy();
        return;
      }
      const setupError = await device.popErrorScope();
      if (setupError || !alive) {
        // Authored blind — surface a WGSL compile failure in dev so it can be fixed
        // (otherwise it just silently falls back to the SVG).
        if (setupError && import.meta.env.DEV) {
          console.warn('[404 black-hole shader]', setupError.message);
        }
        device.destroy();
        return;
      }

      setGpuActive(true);
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

  const digit = 'text-[clamp(72px,17vw,165px)] font-extrabold leading-none';

  return (
    <main className="page-wrap flex flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <h1 className="sr-only">404 — this page does not exist</h1>
      <div
        aria-hidden="true"
        className="flex items-center justify-center tracking-tighter text-(--sea-ink) select-none"
      >
        <span className={digit}>4</span>
        <span
          className="relative shrink-0"
          style={{
            width: 'clamp(150px,32vw,300px)',
            height: 'clamp(150px,32vw,300px)',
            margin: '0 -0.04em',
          }}
        >
          <BlackHoleSvg
            className="absolute inset-0 h-full w-full transition-opacity duration-700"
            style={{ opacity: gpuActive ? 0 : 1 }}
          />
          <canvas
            ref={canvasRef}
            aria-hidden="true"
            className="absolute inset-0 h-full w-full transition-opacity duration-700"
            style={{ opacity: gpuActive ? 1 : 0 }}
          />
        </span>
        <span className={digit}>4</span>
      </div>
      <p className="mt-3 text-(--sea-ink-soft)">
        This page slipped past the event horizon.
      </p>
      <Link
        to="/"
        search={{ search: '' }}
        className="glass mt-8 inline-flex items-center rounded-full px-5 py-2.5 text-sm font-medium text-(--sea-ink) no-underline transition-[box-shadow] duration-300"
      >
        &larr; Back to search
      </Link>
    </main>
  );
}

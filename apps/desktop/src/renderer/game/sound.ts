/**
 * The runner's two sounds, synthesised rather than shipped.
 *
 * The screen they play on is the one that has to work with no network and nothing cached,
 * so a pair of audio files would be the only part of it that could fail to arrive. These
 * are a few oscillators and a noise burst instead: no assets, no decode, no failure mode.
 *
 * The context is created on the first jump, which is a real key press or click, so it
 * satisfies the autoplay policy without the game ever making a sound unprompted.
 */

let ctx: AudioContext | null = null;
let failed = false;

/** The shared context, started on first need. Null if audio is unavailable at all. */
function context(): AudioContext | null {
  if (failed) return null;
  try {
    ctx ??= new AudioContext();
    // Suspended is the normal state before a gesture, and after the OS sleeps the device.
    // Caught, not just voided: it rejects on a closed context or a device that has gone
    // away, and an unhandled rejection over a sound effect is not worth surfacing.
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    return ctx;
  } catch {
    failed = true; // no audio device, or blocked outright: never try again
    return null;
  }
}

/** The short rising blip on take-off, in the spirit of the one everyone already knows. */
export function playJump(): void {
  const c = context();
  if (!c) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'square';
  // Rising, so it reads as leaving the ground rather than landing on it.
  osc.frequency.setValueAtTime(620, t);
  osc.frequency.exponentialRampToValueAtTime(1180, t + 0.055);
  // Ramps run to a whisper rather than to zero: exponentialRamp cannot reach 0.
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.14, t + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
  osc.connect(gain).connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.12);
}

/** The crash: a bass drop with a short body of filtered noise under it. */
export function playCrash(): void {
  const c = context();
  if (!c) return;
  const t = c.currentTime;

  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(38, t + 0.45);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.42, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
  osc.connect(gain).connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.56);

  // Noise gives the drop an impact; without it the bass alone reads as a note, not a hit.
  const length = Math.floor(c.sampleRate * 0.22);
  const buffer = c.createBuffer(1, length, c.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const fade = 1 - i / length;
    samples[i] = (Math.random() * 2 - 1) * fade * fade;
  }
  const noise = c.createBufferSource();
  noise.buffer = buffer;
  const lowpass = c.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 260; // keep it in the bass; the top end reads as static
  const noiseGain = c.createGain();
  noiseGain.gain.value = 0.3;
  noise.connect(lowpass).connect(noiseGain).connect(c.destination);
  noise.start(t);
}

/** Releases the audio device when the screen goes; a new one is made on the next jump. */
export function closeSound(): void {
  void ctx?.close().catch(() => undefined);
  ctx = null;
}

/** Phone motion sensors for the sensor engine and for steadiness: DeviceMotion, with iOS's permission prompt. */
export interface MotionSample {
  t: number;
  ax: number;
  ay: number;
  az: number;
  gx?: number;
  gy?: number;
  gz?: number;
}

export function motionAvailable(): boolean {
  return typeof window !== "undefined" && "DeviceMotionEvent" in window;
}

/** iOS asks once, from a tap; other browsers allow it outright. */
export async function requestMotion(): Promise<boolean> {
  const D = (window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
  if (!D) return false;
  if (typeof D.requestPermission === "function") {
    try {
      return (await D.requestPermission()) === "granted";
    } catch {
      return false;
    }
  }
  return true;
}

/** Collects motion samples until stopped; `onSample` sees each one (used for live steadiness). */
export function listenMotion(onSample?: (s: MotionSample) => void): { stop(): MotionSample[] } {
  const samples: MotionSample[] = [];
  const t0 = performance.now();
  const h = (e: DeviceMotionEvent) => {
    const a = e.acceleration ?? e.accelerationIncludingGravity;
    if (!a || a.x === null) return;
    const r = e.rotationRate;
    const s: MotionSample = { t: (performance.now() - t0) / 1000, ax: a.x ?? 0, ay: a.y ?? 0, az: a.z ?? 0 };
    if (r && r.alpha !== null) Object.assign(s, { gx: ((r.beta ?? 0) * Math.PI) / 180, gy: ((r.gamma ?? 0) * Math.PI) / 180, gz: ((r.alpha ?? 0) * Math.PI) / 180 });
    samples.push(s);
    onSample?.(s);
  };
  window.addEventListener("devicemotion", h);
  return {
    stop() {
      window.removeEventListener("devicemotion", h);
      return samples;
    }
  };
}

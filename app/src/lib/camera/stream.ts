export type CameraError = 'denied' | 'no-camera' | 'insecure' | 'failed'

export interface CameraHandle {
  stream: MediaStream
  /** True if the device reports torch support. */
  hasTorch: boolean
  setTorch(on: boolean): Promise<void>
  /** The camera's own zoom range, or null (then zoom is a digital crop). */
  zoom: { min: number; max: number } | null
  setZoom(z: number): Promise<void>
  stop(): void
}

/**
 * Open the rear camera and attach it to a video element. The element must
 * already have playsinline/muted/autoplay attributes (iOS requirement) and
 * this must be called from a user gesture.
 */
export async function openCamera(
  video: HTMLVideoElement,
  onLost: () => void,
): Promise<CameraHandle | CameraError> {
  // Browsers only expose the live camera on a secure origin. Over a plain
  // http:// LAN address (e.g. a dev server opened from a phone) mediaDevices
  // is missing entirely - report that distinctly rather than "no camera".
  if (!window.isSecureContext) return 'insecure'
  if (!navigator.mediaDevices?.getUserMedia) return 'no-camera'
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    })
  } catch (err) {
    const name = err instanceof DOMException ? err.name : ''
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied'
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-camera'
    return 'failed'
  }

  video.srcObject = stream
  try {
    await video.play()
  } catch {
    // iOS can reject play() when not gesture-initiated; surface as failure.
    stream.getTracks().forEach((t) => t.stop())
    return 'failed'
  }

  const track = stream.getVideoTracks()[0]
  const caps = track.getCapabilities?.() as
    | (MediaTrackCapabilities & { torch?: boolean; zoom?: { min: number; max: number } })
    | undefined
  const hasTorch = caps?.torch === true
  const zoom = caps?.zoom && caps.zoom.max > caps.zoom.min ? { min: caps.zoom.min, max: caps.zoom.max } : null

  const handleEnded = (): void => onLost()
  track.addEventListener('ended', handleEnded)
  const handleVisibility = (): void => {
    // iOS kills the stream when backgrounded; report it so the UI re-acquires.
    if (document.visibilityState === 'visible' && track.readyState === 'ended') onLost()
  }
  document.addEventListener('visibilitychange', handleVisibility)

  return {
    stream,
    hasTorch,
    async setTorch(on: boolean) {
      try {
        await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] })
      } catch {
        // Torch not available; ignore.
      }
    },
    zoom,
    async setZoom(z: number) {
      try {
        await track.applyConstraints({ advanced: [{ zoom: z } as MediaTrackConstraintSet] })
      } catch {
        // Zoom refused; the preview just stays where it was.
      }
    },
    stop() {
      track.removeEventListener('ended', handleEnded)
      document.removeEventListener('visibilitychange', handleVisibility)
      stream.getTracks().forEach((t) => t.stop())
      video.srcObject = null
    },
  }
}

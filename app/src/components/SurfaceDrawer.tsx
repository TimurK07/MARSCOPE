import { useEffect, useState } from 'react'
import { fetchSolImages, type RoverImage, type RoverStop } from '../lib/nasa'
import { fmtCoord } from '../hooks/usePlan'

/** Image that retries a few times when a load fails on a flaky connection. */
function RetryImg({ src, alt }: { src: string; alt: string }) {
  const [attempt, setAttempt] = useState(0)
  return (
    <img
      src={attempt === 0 ? src : `${src}?retry=${attempt}`}
      alt={alt}
      onError={() => attempt < 4 && setTimeout(() => setAttempt((a) => a + 1), 700 * (attempt + 1))}
    />
  )
}

/** Surface view: Navcam frames Curiosity took at the selected stop. */
export default function SurfaceView({ stop, onClose }: { stop: RoverStop; onClose: () => void }) {
  const [images, setImages] = useState<RoverImage[] | 'loading' | 'error'>('loading')

  useEffect(() => {
    let live = true
    setImages('loading')
    fetchSolImages(stop.sol).then(
      (imgs) => live && setImages(imgs),
      () => live && setImages('error'),
    )
    return () => {
      live = false
    }
  }, [stop])

  return (
    <div className="surf">
      <div className="surf-meta">
        <span className="label">Curiosity stop</span>
        <strong>Sol {stop.sol}</strong>
        <code>{fmtCoord(stop)}</code>
        <p>Navcam frames taken at this stop. NASA/JPL-Caltech.</p>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
          Clear
        </button>
      </div>
      <div className="strip">
        {images === 'loading' && <p className="muted">Loading frames from mars.nasa.gov…</p>}
        {images === 'error' && <p className="muted">Could not reach the raw image service.</p>}
        {Array.isArray(images) && images.length === 0 && <p className="muted">No Navcam frames were taken on this sol.</p>}
        {Array.isArray(images) &&
          images.map((im) => (
            <a key={im.id} href={im.link} target="_blank" rel="noreferrer">
              <RetryImg src={im.url} alt={`Curiosity Navcam frame, sol ${im.sol}`} />
              <span>
                {im.lmst && <code>{im.lmst} LMST</code>}
                {im.azimuth != null && <code>az {Math.round(im.azimuth)}°</code>}
              </span>
            </a>
          ))}
      </div>
    </div>
  )
}

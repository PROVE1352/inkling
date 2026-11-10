import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useT } from '../../i18n'
import {
  INTRO_DURATION,
  SCENE_COUNT,
  STILL_TIMES,
  captionOpacity,
  renderIntroFrame,
  sceneAt,
  sceneStart,
  type IntroCopy,
} from './scenes'

// The intro player (docs/adr/2382-*). The scenes are pure functions of t (scenes.ts); this file only
// owns the clock (requestAnimationFrame), the controls and the dialog. With prefers-reduced-motion
// nothing moves: each scene is a still (the scene at STILL_TIMES[i]) and the arrows turn the slides.
//
// Frame-by-frame driving for a promo render, independent of the clock, while the dialog is open:
//   window.__inklingIntro.seek(t)      pause and show time t (seconds, 0 … duration)
//   window.__inklingIntro.stage(true)  the fixed 1920×1080 stage with captions drawn in the frame
//   window.__inklingIntro.duration     total length in seconds

const REDUCE = '(prefers-reduced-motion: reduce)'
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(REDUCE)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => window.matchMedia(REDUCE).matches,
    () => false,
  )
}

interface IntroHandle {
  duration: number
  seek: (t: number) => void
  stage: (on: boolean) => void
  play: () => void
  pause: () => void
  scene: () => number
}
declare global {
  interface Window {
    __inklingIntro?: IntroHandle
  }
}

export function IntroOverlay({ onClose }: { onClose: (finished: boolean) => void }) {
  const t = useT()
  const reduced = useReducedMotion()
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [stage, setStage] = useState(false)
  const [slide, setSlide] = useState(0)
  const timeRef = useRef(0)
  const dialogRef = useRef<HTMLDivElement>(null)

  const copy = useMemo<IntroCopy>(
    () => ({
      scenes: [1, 2, 3, 4].map((n) => ({
        title: t(`intro.s${n}.title` as never),
        body: t(`intro.s${n}.body` as never),
        alt: t(`intro.s${n}.alt` as never),
      })),
      pageA: t('intro.pageA'),
      pageB: t('intro.pageB'),
      peer: t('intro.peer'),
      backlink: t('intro.backlink'),
      views: [t('intro.view.table'), t('intro.view.board'), t('intro.view.calendar')],
      statuses: [t('intro.status.todo'), t('intro.status.doing'), t('intro.status.done')],
      rows: [t('intro.row1'), t('intro.row2'), t('intro.row3'), t('intro.row4')],
      agent: t('intro.agent'),
      clients: t('intro.clients'),
      suggestion: t('intro.suggestion'),
      undo: t('intro.undo'),
      server: t('intro.server'),
      offline: t('intro.offline'),
      openSource: t('intro.openSource'),
      tagline: t('intro.tagline'),
    }),
    [t],
  )

  const seekTo = useCallback((v: number) => {
    const c = Math.min(Math.max(v, 0), INTRO_DURATION)
    timeRef.current = c
    setTime(c)
  }, [])

  // The clock: only while playing, animated and not on the export stage.
  useEffect(() => {
    if (!playing || reduced) return
    let raf = 0
    let last = performance.now()
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const next = timeRef.current + dt
      if (next >= INTRO_DURATION) {
        seekTo(INTRO_DURATION)
        setPlaying(false)
        return
      }
      seekTo(next)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, reduced, seekTo])

  const ended = !reduced && time >= INTRO_DURATION
  const index = reduced ? slide : sceneAt(time).index
  const goScene = useCallback(
    (i: number) => {
      const k = Math.min(Math.max(i, 0), SCENE_COUNT - 1)
      if (reduced) setSlide(k)
      else {
        seekTo(sceneStart(k))
        setPlaying(true)
      }
    },
    [reduced, seekTo],
  )

  // The frame-by-frame handle (removed with the dialog).
  useEffect(() => {
    const handle: IntroHandle = {
      duration: INTRO_DURATION,
      seek: (v) => {
        setPlaying(false)
        seekTo(v)
      },
      stage: (on) => setStage(on),
      play: () => setPlaying(true),
      pause: () => setPlaying(false),
      scene: () => sceneAt(timeRef.current).index,
    }
    window.__inklingIntro = handle
    return () => {
      if (window.__inklingIntro === handle) delete window.__inklingIntro
    }
  }, [seekTo])

  // Keys: Esc skips, ←/→ change scenes, Space pauses (on slides: next). Captured so the editor and
  // app shortcuts underneath never see them while the intro is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose(false)
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault()
        e.stopPropagation()
        goScene(index + (e.key === 'ArrowRight' ? 1 : -1))
      } else if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault()
        e.stopPropagation()
        if (reduced) goScene(index + 1)
        else if (ended) {
          seekTo(0)
          setPlaying(true)
        } else setPlaying((p) => !p)
      } else if (e.key === 'Tab') {
        // keep focus inside the dialog
        const root = dialogRef.current
        if (!root) return
        const f = [...root.querySelectorAll<HTMLElement>('button:not([disabled])')]
        if (f.length === 0) return
        const i = f.indexOf(document.activeElement as HTMLElement)
        if (e.shiftKey && i <= 0) {
          e.preventDefault()
          f[f.length - 1].focus()
        } else if (!e.shiftKey && i === f.length - 1) {
          e.preventDefault()
          f[0].focus()
        }
      } else if (!e.metaKey && !e.ctrlKey) {
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [ended, goScene, index, onClose, reduced, seekTo])

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => prev?.focus?.()
  }, [])

  const frameT = reduced ? STILL_TIMES[slide] : time
  const art = useMemo(() => renderIntroFrame(frameT, copy, { frame: stage ? 'full' : 'art' }), [frameT, copy, stage])
  const scene = copy.scenes[index]
  const capO = reduced || ended ? 1 : captionOpacity(time)
  const last = index === SCENE_COUNT - 1

  if (stage) {
    // The export stage: exactly 1920×1080 CSS pixels at the top left, captions inside the frame.
    return (
      <div
        data-testid="intro-stage"
        style={{ position: 'fixed', left: 0, top: 0, width: 1920, height: 1080, zIndex: 90, background: 'var(--color-app)' }}
        dangerouslySetInnerHTML={{ __html: art }}
      />
    )
  }

  const iconBtn =
    'flex h-9 w-9 items-center justify-center rounded-full text-sub transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-30'
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-0 sm:p-6" data-testid="intro-overlay">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="intro-title"
        aria-describedby="intro-body"
        tabIndex={-1}
        className="relative flex h-full w-full max-w-5xl flex-col overflow-hidden bg-app shadow-2xl outline-none sm:h-auto sm:max-h-full sm:rounded-[var(--radius-xl)]"
      >
        <div className="flex items-center gap-2 px-4 pt-3">
          <span className="text-xs font-medium text-sub">{t('intro.label')}</span>
          <span className="flex-1" />
          <button type="button" onClick={() => onClose(false)} className="rounded-md px-2.5 py-1.5 text-sm text-sub hover:bg-hover hover:text-ink" data-testid="intro-skip">
            {t('intro.skip')}
          </button>
        </div>

        <div className="flex min-h-0 flex-1 items-center justify-center px-2 sm:flex-none sm:px-6">
          <div
            role="img"
            aria-label={scene.alt}
            className="aspect-[1560/720] max-h-full w-full sm:max-h-[58vh]"
            data-testid="intro-art"
            data-scene={index}
            dangerouslySetInnerHTML={{ __html: art }}
          />
        </div>

        <div className="flex shrink-0 flex-col justify-end px-5 pb-4 pt-2 sm:px-8">
          <div aria-live="polite" style={{ opacity: capO }} className="min-h-[7.5rem]">
            <h2 id="intro-title" className="text-xl font-bold text-ink sm:text-2xl" data-testid="intro-title">
              {scene.title}
            </h2>
            <p id="intro-body" className="mt-1.5 text-[15px] leading-relaxed text-sub sm:text-base">
              {scene.body}
            </p>
          </div>

          <div className="mt-3 flex items-center gap-1">
            <button type="button" onClick={() => goScene(index - 1)} disabled={index === 0} aria-label={t('intro.prev')} className={iconBtn} data-testid="intro-prev">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
            </button>
            {!reduced && (
              <button
                type="button"
                onClick={() => {
                  if (ended) {
                    seekTo(0)
                    setPlaying(true)
                  } else setPlaying((p) => !p)
                }}
                aria-label={ended ? t('intro.again') : playing ? t('intro.pause') : t('intro.play')}
                className={iconBtn}
                data-testid="intro-pause"
              >
                {playing && !ended ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5Z" /></svg>
                )}
              </button>
            )}
            <button type="button" onClick={() => goScene(index + 1)} disabled={last} aria-label={t('intro.next')} className={iconBtn} data-testid="intro-next">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
            </button>
            <div className="mx-2 flex items-center gap-1.5" role="group" aria-label={t('intro.label')}>
              {Array.from({ length: SCENE_COUNT }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => goScene(i)}
                  aria-label={t('intro.scene', { n: i + 1, total: SCENE_COUNT })}
                  aria-current={i === index ? 'step' : undefined}
                  className="flex h-6 w-6 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  data-testid={`intro-dot-${i}`}
                >
                  <span className={`block h-2 rounded-full transition-all duration-200 ${i === index ? 'w-5 bg-accent' : 'w-2 bg-line'}`} />
                </button>
              ))}
            </div>
            <span className="flex-1" />
            {(ended || (reduced && last)) && (
              <button type="button" onClick={() => onClose(true)} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90" data-testid="intro-start">
                {t('intro.start')}
              </button>
            )}
          </div>
          <p className="mt-2 hidden text-xs text-sub/80 sm:block">{t('intro.keys')}</p>
        </div>
      </div>
    </div>
  )
}

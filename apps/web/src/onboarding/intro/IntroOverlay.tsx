import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useCreatePage, usePages } from '../../api'
import { useT, type TKey } from '../../i18n'
import { newPageTarget } from '../../lib/newPage'
import { getPrefs } from '../../lib/prefs'
import { toast } from '../../lib/toast'
import { useIsGuest } from '../../lib/useGuest'
import { useCreateSample, useOnboarding } from '../api'
import { showHint } from '../hint'
import {
  INTRO_DURATION,
  INTRO_WORDS,
  SCENE_COUNT,
  STILL_TIMES,
  captionOpacity,
  renderIntroFrame,
  sceneAt,
  sceneStart,
  type IntroCopy,
} from './scenes'

// The intro player (docs/adr/2382-*, 2385-*). The scenes are pure functions of t (scenes.ts); this file
// only owns the clock (requestAnimationFrame), the controls, the dialog and the end screen. With
// prefers-reduced-motion nothing moves: each scene is a still (the scene at STILL_TIMES[i]) and the
// arrows turn the slides.
//
// When the clock runs out (or after the last slide) the intro does not close by itself: it stops on the
// end screen (HTML under the picture's last frame) with the next things to do. Each of them marks the
// intro seen, closes it and then does what it says.
//
// Frame-by-frame driving for a promo render, independent of the clock, while the dialog is open:
//   window.__inklingIntro.seek(t)      pause and show time t (seconds, 0 … duration); never the end screen
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

type EndAction = 'sampleOpen' | 'sampleCreate' | 'newPage' | 'ai'

export function IntroOverlay({ onClose, wsId = '' }: { onClose: (finished: boolean) => void; wsId?: string }) {
  const t = useT()
  const reduced = useReducedMotion()
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [stage, setStage] = useState(false)
  const [slide, setSlide] = useState(0)
  // the end screen: reached by the clock running out or by turning past the last slide, never by seek()
  const [finished, setFinished] = useState(false)
  const [aspect, setAspect] = useState(2)
  const timeRef = useRef(0)
  // false as soon as seek()/pause() is called, so a frame already queued cannot run on to the end screen
  const clockOn = useRef(false)
  // play() after seek() in the same tick leaves `playing` true: this restarts the clock anyway
  const [kick, setKick] = useState(0)
  const dialogRef = useRef<HTMLDivElement>(null)
  const artRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const copy = useMemo<IntroCopy>(
    () => ({
      scenes: [1, 2, 3, 4].map((n) => ({
        title: t(`intro.s${n}.title` as TKey),
        body: t(`intro.s${n}.body` as TKey),
        alt: t(`intro.s${n}.alt` as TKey),
      })),
      w: Object.fromEntries(INTRO_WORDS.map((k) => [k, t(`intro.${k}` as TKey)])) as IntroCopy['w'],
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
    clockOn.current = true
    const step = (now: number) => {
      if (!clockOn.current) return
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const next = timeRef.current + dt
      if (next >= INTRO_DURATION) {
        seekTo(INTRO_DURATION)
        setPlaying(false)
        setFinished(true)
        return
      }
      seekTo(next)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => {
      clockOn.current = false
      cancelAnimationFrame(raf)
    }
  }, [playing, reduced, seekTo, kick])

  // The picture's box decides how the camera frames each scene (a phone gets a closer, taller frame).
  useLayoutEffect(() => {
    const el = artRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) setAspect(Math.round((r.width / r.height) * 50) / 50)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [stage])

  const index = reduced ? Math.min(slide, SCENE_COUNT - 1) : sceneAt(time).index
  const goScene = useCallback(
    (i: number) => {
      const k = Math.min(Math.max(i, 0), SCENE_COUNT - 1)
      setFinished(false)
      if (reduced) setSlide(k)
      else {
        seekTo(sceneStart(k))
        setPlaying(true)
      }
    },
    [reduced, seekTo],
  )
  const replay = useCallback(() => {
    setFinished(false)
    if (reduced) setSlide(0)
    else {
      seekTo(0)
      setPlaying(true)
    }
  }, [reduced, seekTo])
  const next = useCallback(() => {
    if (finished) return
    if (index === SCENE_COUNT - 1) {
      // past the last scene: the end screen
      if (!reduced) {
        seekTo(INTRO_DURATION)
        setPlaying(false)
      }
      setFinished(true)
    } else goScene(index + 1)
  }, [finished, goScene, index, reduced, seekTo])
  const prev = useCallback(() => goScene(finished ? SCENE_COUNT - 1 : index - 1), [finished, goScene, index])

  // The frame-by-frame handle (removed with the dialog).
  useEffect(() => {
    const handle: IntroHandle = {
      duration: INTRO_DURATION,
      seek: (v) => {
        clockOn.current = false
        setPlaying(false)
        setFinished(false)
        seekTo(v)
      },
      stage: (on) => setStage(on),
      play: () => {
        setPlaying(true)
        setKick((k) => k + 1)
      },
      pause: () => {
        clockOn.current = false
        setPlaying(false)
      },
      scene: () => sceneAt(timeRef.current).index,
    }
    window.__inklingIntro = handle
    return () => {
      if (window.__inklingIntro === handle) delete window.__inklingIntro
    }
  }, [seekTo])

  // ---- the end screen: what to do next ------------------------------------------------------------
  const navigate = useNavigate()
  const { pageId } = useParams()
  const onboarding = useOnboarding()
  const guest = useIsGuest(wsId)
  const pages = usePages(wsId)
  const createPage = useCreatePage(wsId)
  const sample = useCreateSample()
  const canWrite = !!wsId && !guest
  // a new account (the checklist is for them; an existing account shown the intro once has it off and is
  // never offered the sample, docs/adr/2383-*)
  const offerSample = canWrite && !!onboarding && onboarding.audience !== 'guest' && !onboarding.checklist.dismissed
  const samplePage = onboarding?.samples[wsId]
  const actions: { id: EndAction; label: string }[] = []
  if (offerSample) actions.push(samplePage ? { id: 'sampleOpen', label: t('intro.end.sampleOpen') } : { id: 'sampleCreate', label: t('intro.end.sampleCreate') })
  if (canWrite) actions.push({ id: 'newPage', label: t('intro.end.newPage') })
  if (wsId) actions.push({ id: 'ai', label: t('intro.end.ai') })

  const run = async (id: EndAction) => {
    // seen and closed first; the action outlives the dialog (mutateAsync, not per-call callbacks)
    onClose(true)
    try {
      if (id === 'sampleOpen') navigate(`/w/${wsId}/p/${samplePage}`)
      else if (id === 'ai') {
        navigate(`/w/${wsId}/settings#connections`)
        showHint(['[data-pref="mcp"]'], t('getStarted.item.ai.hint'), t('getStarted.hintClose'))
      } else if (id === 'sampleCreate') {
        const r = await sample.mutateAsync(wsId)
        navigate(`/w/${wsId}/p/${r.pageId}`)
      } else {
        // the same rules as the sidebar's New page (lib/newPage.ts)
        const current = pageId ? pages.data?.find((p) => p.id === pageId) : undefined
        const page = await createPage.mutateAsync({ workspaceId: wsId, ...newPageTarget(getPrefs().newPageLocation, current, pages.data) })
        navigate(`/w/${wsId}/p/${page.id}`)
      }
    } catch {
      toast({ message: id === 'sampleCreate' ? t('getStarted.sampleFailed') : t('intro.end.failed') })
    }
  }

  useEffect(() => {
    if (finished) endRef.current?.querySelector<HTMLElement>('button')?.focus()
  }, [finished])

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
        if (e.key === 'ArrowRight') next()
        else prev()
      } else if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault()
        e.stopPropagation()
        if (finished) replay()
        else if (reduced) next()
        else setPlaying((p) => !p)
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
  }, [finished, next, onClose, prev, reduced, replay])

  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => prevFocus?.focus?.()
  }, [])

  const frameT = finished ? INTRO_DURATION : reduced ? STILL_TIMES[index] : time
  const art = useMemo(
    () => renderIntroFrame(frameT, copy, stage ? { frame: 'full' } : { frame: 'art', aspect }),
    [frameT, copy, stage, aspect],
  )
  const scene = copy.scenes[index]
  const capO = reduced || finished ? 1 : captionOpacity(time)

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
  const endBtn =
    'rounded-md px-3.5 py-2 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app'
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-0 sm:p-6" data-testid="intro-overlay">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="intro-title"
        aria-describedby="intro-body"
        tabIndex={-1}
        className="relative flex h-full w-full max-w-5xl flex-col overflow-hidden bg-app shadow-2xl outline-none sm:h-[min(100%,780px)] sm:rounded-[var(--radius-xl)]"
      >
        <div className="flex shrink-0 items-center gap-2 px-4 pt-3">
          <span className="text-xs font-medium text-sub">{t('intro.label')}</span>
          <span className="flex-1" />
          <button type="button" onClick={() => onClose(false)} className="rounded-md px-2.5 py-1.5 text-sm text-sub hover:bg-hover hover:text-ink" data-testid="intro-skip">
            {t('intro.skip')}
          </button>
        </div>

        <div className="min-h-0 flex-1 px-2 pt-1 sm:px-6">
          <div
            ref={artRef}
            role="img"
            aria-label={finished ? t('intro.end.logo') : scene.alt}
            className="h-full w-full"
            data-testid="intro-art"
            data-scene={index}
            dangerouslySetInnerHTML={{ __html: art }}
          />
        </div>

        <div className="flex shrink-0 flex-col justify-end px-5 pb-4 pt-2 sm:px-8">
          {finished ? (
            <div ref={endRef} data-testid="intro-end" className="min-h-[7.5rem]">
              <p id="intro-body" className="text-sm text-sub">
                {t('intro.tagline')}
              </p>
              <h2 id="intro-title" className="mt-1 text-xl font-bold text-ink sm:text-2xl" data-testid="intro-title">
                {t('intro.end.title')}
              </h2>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                {actions.map((a, i) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => void run(a.id)}
                    className={`${endBtn} ${i === 0 ? 'bg-accent text-white hover:opacity-90' : 'border border-line text-ink hover:bg-hover'}`}
                    data-testid={`intro-end-${a.id}`}
                  >
                    {a.label}
                  </button>
                ))}
                <button type="button" onClick={() => onClose(true)} className={`${endBtn} text-sub hover:bg-hover hover:text-ink`} data-testid="intro-end-close">
                  {t('intro.end.close')}
                </button>
              </div>
            </div>
          ) : (
            <div aria-live="polite" style={{ opacity: capO }} className="min-h-[7.5rem]">
              <h2 id="intro-title" className="text-xl font-bold text-ink sm:text-2xl" data-testid="intro-title">
                {scene.title}
              </h2>
              <p id="intro-body" className="mt-1.5 text-[15px] leading-relaxed text-sub sm:text-base">
                {scene.body}
              </p>
            </div>
          )}

          <div className="mt-3 flex items-center gap-1">
            <button type="button" onClick={prev} disabled={!finished && index === 0} aria-label={t('intro.prev')} className={iconBtn} data-testid="intro-prev">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
            </button>
            {(!reduced || finished) && (
              <button
                type="button"
                onClick={() => (finished ? replay() : setPlaying((p) => !p))}
                aria-label={finished ? t('intro.again') : playing ? t('intro.pause') : t('intro.play')}
                className={iconBtn}
                data-testid="intro-pause"
              >
                {finished ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
                ) : playing ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5Z" /></svg>
                )}
              </button>
            )}
            <button type="button" onClick={next} disabled={finished} aria-label={t('intro.next')} className={iconBtn} data-testid="intro-next">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
            </button>
            <div className="mx-2 flex items-center gap-1.5" role="group" aria-label={t('intro.label')}>
              {Array.from({ length: SCENE_COUNT }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => goScene(i)}
                  aria-label={t('intro.scene', { n: i + 1, total: SCENE_COUNT })}
                  aria-current={!finished && i === index ? 'step' : undefined}
                  className="flex h-6 w-6 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  data-testid={`intro-dot-${i}`}
                >
                  <span className={`block h-2 rounded-full transition-all duration-200 ${!finished && i === index ? 'w-5 bg-accent' : 'w-2 bg-line'}`} />
                </button>
              ))}
            </div>
          </div>
          <p className="mt-2 hidden text-xs text-sub/80 sm:block">{t('intro.keys')}</p>
        </div>
      </div>
    </div>
  )
}

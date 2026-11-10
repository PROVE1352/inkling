import { useT } from '../i18n'
import { Group, Row, Toggle } from '../components/SettingsRows'
import { playIntro, useOnboarding, useUpdateOnboarding } from './api'

// Settings › About: watch the intro again and turn the Getting started checklist on or off
// (docs/adr/2380-*). Hidden when the server turned onboarding off, for guests, and while the state
// cannot be read (offline).
export function OnboardingSettings() {
  const t = useT()
  const dto = useOnboarding()
  const update = useUpdateOnboarding()
  if (!dto || dto.audience === 'guest') return null
  const on = !dto.checklist.dismissed
  return (
    <Group title={t('getStarted.settings.title')}>
      <Row id="onboarding-intro" title={t('getStarted.settings.intro')} desc={t('getStarted.settings.introDesc')}>
        <button
          type="button"
          onClick={playIntro}
          className="rounded-md border border-line px-2 py-1 text-xs text-ink transition-colors duration-150 hover:bg-hover"
          data-testid="settings-replay-intro"
        >
          {t('getStarted.settings.play')}
        </button>
      </Row>
      <Row id="onboarding-checklist" title={t('getStarted.settings.checklist')} desc={t('getStarted.settings.checklistDesc')}>
        <Toggle checked={on} onChange={(v) => update.mutate({ dismissed: !v })} label={t('getStarted.settings.checklist')} />
      </Row>
    </Group>
  )
}

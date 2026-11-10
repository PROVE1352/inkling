/**
 * Public form (docs/adr/1821-*, 1822-*): /f/:token. No session, no app shell. The page shows the
 * questions the server hands visitors and posts one answer; it never receives a row.
 */
import { useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import type { PublicFormDTO } from '@inkling/shared'
import { api } from '../api'
import { FormFill } from '../components/collection/FormView'
import { Spinner } from '../components/Spinner'
import { ThemeToggle } from '../components/ThemeToggle'
import { t } from '../i18n'
import { formProblems, publicFormModel, publicQuestions } from '../lib/forms'

export function PublicForm() {
  const { token } = useParams()
  const form = useQuery({
    queryKey: ['public-form', token],
    queryFn: () => api<PublicFormDTO>(`/api/public/forms/${encodeURIComponent(token ?? '')}`),
    enabled: !!token,
    retry: false,
    staleTime: Infinity,
  })
  const dto = form.data
  const model = dto ? publicFormModel(dto) : null
  return (
    <div className="relative flex min-h-full flex-col bg-app">
      <div className="absolute right-3 top-3 z-10">
        <ThemeToggle />
      </div>
      <main className="flex flex-1 flex-col px-4 py-12">
        {form.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner size={22} />
          </div>
        ) : !dto || !model || !token ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
            <img src="/icon.svg" alt="Inkling" className="h-10 w-10 opacity-60" />
            <p className="max-w-xs text-sm text-sub">{t('form.closed')}</p>
          </div>
        ) : (
          <FormFill
            title={dto.title}
            description={dto.description}
            questions={publicQuestions(dto)}
            submitLabel={dto.submitLabel}
            successMessage={dto.successMessage}
            honeypot={dto.honeypot}
            check={(values) => formProblems(model.settings, model.fields, values, true)}
            onSubmit={async (values, trap) => {
              await api<{ ok: true }>(`/api/public/forms/${encodeURIComponent(token)}`, {
                method: 'POST',
                body: JSON.stringify({ values, ...(trap ? { [dto.honeypot]: trap } : {}) }),
              })
            }}
          />
        )}
        <p className="mt-6 text-center text-[11px] text-sub">{t('form.poweredBy')}</p>
      </main>
    </div>
  )
}

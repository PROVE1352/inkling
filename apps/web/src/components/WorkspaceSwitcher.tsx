import { useEffect, useRef, useState } from 'react'
import { WorkspaceAvatar } from './WorkspaceAvatar'
import { useNavigate } from 'react-router'
import {
  createWorkspaceSchema,
  joinWorkspaceSchema,
  type WorkspaceDTO,
} from '@inkling/shared'
import {
  ApiError,
  triggerDownload,
  useCreateWorkspace,
  useImportFolder,
  useImportWorkspace,
  useJoinWorkspace,
} from '../api'
import {
  ChevronDownIcon,
  CheckIcon,
  DownloadIcon,
  PlusIcon,
  SettingsIcon,
  UploadIcon,
  UsersIcon,
} from './Icons'
import { Modal } from './Modal'
import { NotionImportModal } from './NotionImportModal'
import { Spinner } from './Spinner'
import { toast } from '../lib/toast'
import { t, useT } from '../i18n'

export function WorkspaceSwitcher({
  wsId,
  workspaces,
}: {
  wsId: string
  workspaces: WorkspaceDTO[]
}) {
  useT()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [showJoin, setShowJoin] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [showNotion, setShowNotion] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const importWs = useImportWorkspace(wsId)
  const folderRef = useRef<HTMLInputElement>(null)
  const importFolder = useImportFolder(wsId)
  const importing = importWs.isPending || importFolder.isPending

  const current = workspaces.find((w) => w.id === wsId)

  const onImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setImportError(null)
    importWs.mutate(
      { file },
      {
        onSuccess: ({ pages, duplicateAttachments }) => {
          setOpen(false)
          // Identical attachments were stored once (docs/adr/1122-*).
          if (duplicateAttachments > 0) toast({ message: t('workspace.importDuplicates', { count: duplicateAttachments }) })
          const first = pages[0]
          if (first) navigate(`/w/${wsId}/p/${first.id}`)
        },
        onError: (err) =>
          setImportError(err instanceof ApiError ? err.message : t('workspace.importFailed')),
      },
    )
  }

  // Folder picked → keep only .md files (skip .git, node_modules and hidden files)
  const onImportFolder = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (picked.length === 0) return
    const files = picked
      .map((file) => ({ path: file.webkitRelativePath || file.name, file }))
      .filter(({ path }) => {
        const segs = path.split('/')
        if (segs.some((s) => s.startsWith('.') || s === 'node_modules' || s === '__MACOSX')) return false
        return /\.md$/i.test(path)
      })
    setImportError(null)
    if (files.length === 0) {
      setImportError(t('workspace.noMdFiles'))
      return
    }
    if (files.length > 300) {
      setImportError(t('workspace.tooManyFiles', { count: files.length, max: 300 }))
      return
    }
    importFolder.mutate(
      { files },
      {
        onSuccess: (pages) => {
          setOpen(false)
          const first = pages[0]
          if (first) navigate(`/w/${wsId}/p/${first.id}`)
        },
        onError: (err) =>
          setImportError(err instanceof ApiError ? err.message : t('workspace.importFolderFailed')),
      },
    )
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const id = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-hover"
      >
        <WorkspaceAvatar name={current?.name ?? t('workspace.fallbackName')} icon={current?.icon} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
          {current?.name ?? t('workspace.fallbackName')}
        </span>
        <ChevronDownIcon size={16} className="shrink-0 text-sub" />
      </button>

      {open && (
        <div className="nd-pop absolute left-0 right-0 top-full z-40 mt-1 origin-top overflow-hidden rounded-md border border-line bg-app py-1 shadow-xl">
          <div className="max-h-64 overflow-y-auto">
            {workspaces.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => {
                  setOpen(false)
                  if (w.id !== wsId) navigate(`/w/${w.id}`)
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-hover"
              >
                <WorkspaceAvatar name={w.name} icon={w.icon} size={18} />
                <span className="min-w-0 flex-1 truncate">{w.name}</span>
                {w.id === wsId && <CheckIcon size={15} className="text-accent" />}
              </button>
            ))}
          </div>
          <div className="my-1 border-t border-line" />
          {/* Members, sharing, agents, audit, webhooks and the danger zone live on one screen (docs/adr/0945-*) */}
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              navigate(`/w/${wsId}/workspace-settings?tab=members`)
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-sub hover:bg-hover hover:text-ink"
          >
            <UsersIcon size={15} /> {t('members.title')}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              navigate(`/w/${wsId}/workspace-settings`)
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-sub hover:bg-hover hover:text-ink"
          >
            <SettingsIcon size={15} /> {t('wsSettings.menu')}
          </button>

          <div className="my-1 border-t border-line" />
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setShowCreate(true)
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-sub hover:bg-hover hover:text-ink"
          >
            <PlusIcon size={15} /> {t('workspace.new')}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setShowJoin(true)
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-sub hover:bg-hover hover:text-ink"
          >
            <span className="w-[15px] text-center">＃</span> {t('workspace.joinWithCode')}
          </button>

          <div className="my-1 border-t border-line" />
          {(current?.can?.export ?? true) && (
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                triggerDownload(`/api/workspaces/${wsId}/export`)
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-sub hover:bg-hover hover:text-ink"
            >
              <DownloadIcon size={15} /> {t('workspace.exportAll')}
            </button>
          )}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={importing}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-sub hover:bg-hover hover:text-ink disabled:opacity-60"
          >
            {importWs.isPending ? <Spinner size={15} /> : <UploadIcon size={15} />}
            {t('workspace.import')}
          </button>
          <button
            type="button"
            onClick={() => folderRef.current?.click()}
            disabled={importing}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-sub hover:bg-hover hover:text-ink disabled:opacity-60"
          >
            {importFolder.isPending ? <Spinner size={15} /> : <UploadIcon size={15} />}
            {t('workspace.importFolder')}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setShowNotion(true)
            }}
            disabled={importing}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-sub hover:bg-hover hover:text-ink disabled:opacity-60"
          >
            <UploadIcon size={15} />
            {t('notionImport.menu')}
          </button>
          {importError && (
            <p className="px-3 py-1 text-xs text-red-600">{importError}</p>
          )}

        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept=".md,.zip"
        className="hidden"
        onChange={onImportFile}
      />
      <input
        ref={folderRef}
        type="file"
        // @ts-expect-error — non-standard attribute (supported by all major browsers), missing from React's types
        webkitdirectory=""
        multiple
        className="hidden"
        onChange={onImportFolder}
      />

      <NotionImportModal open={showNotion} onClose={() => setShowNotion(false)} wsId={wsId} />
      <CreateWorkspaceModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onDone={(ws) => {
          setShowCreate(false)
          navigate(`/w/${ws.id}`)
        }}
      />
      <JoinWorkspaceModal
        open={showJoin}
        onClose={() => setShowJoin(false)}
        onDone={(ws) => {
          setShowJoin(false)
          navigate(`/w/${ws.id}`)
        }}
      />
    </div>
  )
}

function CreateWorkspaceModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean
  onClose: () => void
  onDone: (ws: WorkspaceDTO) => void
}) {
  const t = useT()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const create = useCreateWorkspace()

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const parsed = createWorkspaceSchema.safeParse({ name })
    if (!parsed.success) {
      setError(t('workspace.nameRequired'))
      return
    }
    create.mutate(parsed.data, {
      onSuccess: (ws) => {
        setName('')
        onDone(ws)
      },
      onError: (err) => setError(err instanceof ApiError ? err.message : t('workspace.createFailed')),
    })
  }

  return (
    <Modal open={open} onClose={onClose} title={t('workspace.new')}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('workspace.namePlaceholder')}
          className="rounded-md border border-line bg-app px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        {error && <p className="text-xs text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={create.isPending}
          className="flex items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition duration-150 hover:opacity-90 active:scale-[.98] disabled:opacity-60"
        >
          {create.isPending && <Spinner size={16} className="border-white/40 border-t-white" />}
          {t('common.create')}
        </button>
      </form>
    </Modal>
  )
}

function JoinWorkspaceModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean
  onClose: () => void
  onDone: (ws: WorkspaceDTO) => void
}) {
  const t = useT()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const join = useJoinWorkspace()

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const parsed = joinWorkspaceSchema.safeParse({ inviteCode: code })
    if (!parsed.success) {
      setError(t('workspace.codeRequired'))
      return
    }
    join.mutate(parsed.data, {
      onSuccess: (ws) => {
        setCode('')
        onDone(ws)
      },
      onError: (err) => {
        if (err instanceof ApiError && err.code === 'INVALID_CODE') {
          setError(t('workspace.codeInvalid'))
        } else {
          setError(err instanceof ApiError ? err.message : t('workspace.joinFailed'))
        }
      },
    })
  }

  return (
    <Modal open={open} onClose={onClose} title={t('workspace.joinWithCode')}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder={t('workspace.codePlaceholder')}
          className="rounded-md border border-line bg-app px-3 py-2 text-sm uppercase tracking-wider text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        {error && <p className="text-xs text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={join.isPending}
          className="flex items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition duration-150 hover:opacity-90 active:scale-[.98] disabled:opacity-60"
        >
          {join.isPending && <Spinner size={16} className="border-white/40 border-t-white" />}
          {t('workspace.join')}
        </button>
      </form>
    </Modal>
  )
}

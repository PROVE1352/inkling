/**
 * Admin → Backups API (docs/BACKUP.md, docs/adr/0605-*).
 *
 *   GET  /api/admin/backups                 sidecar status + read-only config + set list
 *   POST /api/admin/backups/run             queue a backup now (trigger file)
 *   GET  /api/admin/backups/:id/download    stream the set as an uncompressed .tar
 *
 * Restoring is deliberately NOT exposed over HTTP — it is CLI only (deploy/restore.sh).
 * All routes are admin + browser-session only (requireAdmin rejects MCP tokens).
 */
import { spawn } from 'node:child_process'
import type { FastifyInstance } from 'fastify'
import { getUser, requireAdmin } from '../auth'
import { AppError, notFound } from '../errors'
import { startBackupMonitor } from './monitor'
import {
  currentAlert,
  isConfigured,
  isStale,
  listSets,
  pendingTrigger,
  readStatus,
  SETS_DIR,
  setDir,
  writeAppInfo,
  writeTrigger,
} from './store'

export async function registerBackupRoutes(app: FastifyInstance): Promise<void> {
  const admin = { preHandler: requireAdmin }

  await writeAppInfo((msg) => app.log.warn(msg))
  const stopMonitor = startBackupMonitor((msg) => app.log.warn(msg))
  app.addHook('onClose', async () => stopMonitor())

  app.get('/admin/backups', admin, async () => {
    if (!(await isConfigured())) {
      return { configured: false, status: null, alert: null, stale: false, pending: null, sets: [] }
    }
    const [status, sets, pending] = await Promise.all([readStatus(), listSets(), pendingTrigger()])
    return {
      configured: true,
      status,
      alert: status ? currentAlert(status) : null,
      stale: status ? isStale(status) : false,
      pending,
      sets,
    }
  })

  app.post(
    '/admin/backups/run',
    { preHandler: requireAdmin, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!(await isConfigured())) {
        throw new AppError(409, 'BACKUP_NOT_CONFIGURED', 'The backup service is not set up on this server')
      }
      const status = await readStatus()
      if (!status) {
        throw new AppError(503, 'BACKUP_SIDECAR_DOWN', 'The backup service has not started yet')
      }
      if (status.config?.enabled === false) {
        throw new AppError(409, 'BACKUP_DISABLED', 'Backups are disabled (BACKUP_ENABLED=0)')
      }
      if (isStale(status)) {
        throw new AppError(503, 'BACKUP_SIDECAR_DOWN', 'The backup service is not responding')
      }
      if (status.running) {
        throw new AppError(409, 'BACKUP_RUNNING', 'A backup is already running')
      }
      if (!(await writeTrigger(getUser(req).id))) {
        throw new AppError(409, 'BACKUP_QUEUED', 'A backup is already queued')
      }
      return reply.code(202).send({ queued: true })
    },
  )

  app.get<{ Params: { id: string } }>('/admin/backups/:id/download', admin, async (req, reply) => {
    const dir = await setDir(req.params.id)
    if (!dir) throw notFound('BACKUP_NOT_FOUND', 'Backup set not found')
    const id = req.params.id
    // Plain (uncompressed) tar of the set directory: the payload is already compressed and,
    // when BACKUP_PASSPHRASE is set, already encrypted — it is streamed as stored.
    const child = spawn('tar', ['-cf', '-', '-C', SETS_DIR, id], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (b: Buffer) => {
      if (stderr.length < 2000) stderr += b.toString()
    })
    child.on('close', (code) => {
      if (code !== 0 && code !== null) req.log.warn(`[backup] tar of ${id} exited ${code}: ${stderr.trim()}`)
    })
    child.on('error', (err) => req.log.error(`[backup] cannot spawn tar: ${err.message}`))
    reply.raw.on('close', () => {
      if (child.exitCode === null) child.kill('SIGTERM')
    })
    req.log.info(`[backup] download of set ${id} by ${getUser(req).id}`)
    return reply
      .header('Content-Type', 'application/x-tar')
      .header('Content-Disposition', `attachment; filename="inkling-backup-${id}.tar"`)
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(child.stdout)
  })
}

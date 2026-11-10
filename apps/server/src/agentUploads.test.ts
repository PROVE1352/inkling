// Uploads by AI agents: server default, limits and the workspace choice (docs/adr/2065-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { agentUploadLimitsLine, decideAgentUploads, parseAgentUploadEnv } from './agentUploads'
import { isUploadCall } from './mcpBody'

const MB = 1024 * 1024

describe('parseAgentUploadEnv', () => {
  it('defaults: on, 5 MB, 200 MB a day, no warnings', () => {
    assert.deepEqual(parseAgentUploadEnv({}), { mode: 'on', maxBytes: 5 * MB, dailyBytes: 200 * MB, mcpUploadBodyBytes: 12 * MB, warnings: [] })
    assert.equal(agentUploadLimitsLine(parseAgentUploadEnv({})), null)
  })

  it('takes on, off and never in any case', () => {
    assert.equal(parseAgentUploadEnv({ AGENT_UPLOADS: 'OFF' }).mode, 'off')
    assert.equal(parseAgentUploadEnv({ AGENT_UPLOADS: ' never ' }).mode, 'never')
    assert.equal(parseAgentUploadEnv({ AGENT_UPLOADS: 'on' }).mode, 'on')
    assert.equal(parseAgentUploadEnv({ AGENT_UPLOADS: '' }).warnings.length, 0)
  })

  it('an unknown mode is off with a warning', () => {
    const e = parseAgentUploadEnv({ AGENT_UPLOADS: 'yes' })
    assert.equal(e.mode, 'off')
    assert.equal(e.warnings.length, 1)
    assert.match(e.warnings[0], /AGENT_UPLOADS=yes/)
  })

  it('the per-file cap can be raised to 64 MB; above that it is cut with a warning; bad numbers keep the default', () => {
    const raised = parseAgentUploadEnv({ AGENT_UPLOAD_MAX_MB: '20' })
    assert.equal(raised.maxBytes, 20 * MB)
    assert.deepEqual(raised.warnings, [])
    const big = parseAgentUploadEnv({ AGENT_UPLOAD_MAX_MB: '500' })
    assert.equal(big.maxBytes, 64 * MB)
    assert.match(big.warnings[0], /above 64/)
    assert.equal(parseAgentUploadEnv({ AGENT_UPLOAD_MAX_MB: '2.5' }).maxBytes, Math.floor(2.5 * MB))
    const bad = parseAgentUploadEnv({ AGENT_UPLOAD_MAX_MB: '-1', AGENT_UPLOAD_DAILY_MB: 'lots' })
    assert.equal(bad.maxBytes, 5 * MB)
    assert.equal(bad.dailyBytes, 200 * MB)
    assert.equal(bad.warnings.length, 2)
    assert.equal(parseAgentUploadEnv({ AGENT_UPLOAD_MAX_MB: '0' }).maxBytes, 5 * MB) // 0 is not "unlimited"
    assert.equal(parseAgentUploadEnv({ AGENT_UPLOAD_DAILY_MB: '50' }).dailyBytes, 50 * MB)
  })

  it('a daily budget of 0 is no budget', () => {
    const e = parseAgentUploadEnv({ AGENT_UPLOAD_DAILY_MB: '0' })
    assert.equal(e.dailyBytes, null)
    assert.deepEqual(e.warnings, [])
    assert.match(agentUploadLimitsLine(e)!, /no daily budget/)
  })

  it('the MCP body follows the cap only when base64 of the file no longer fits in 12 MB', () => {
    assert.equal(parseAgentUploadEnv({ AGENT_UPLOAD_MAX_MB: '8' }).mcpUploadBodyBytes, 12 * MB)
    const e = parseAgentUploadEnv({ AGENT_UPLOAD_MAX_MB: '30' })
    assert.equal(e.mcpUploadBodyBytes, Math.ceil((30 * MB) / 3) * 4 + MB)
    assert.match(agentUploadLimitsLine(e)!, /up to 30 MB per file; MCP requests that call upload_file accept up to 41 MB \(others stay at 12 MB\)/)
  })

  it('only upload_file calls (direct or through more_tools) count as upload calls', () => {
    assert.equal(isUploadCall({ method: 'tools/call', params: { name: 'upload_file', arguments: {} } }), true)
    assert.equal(isUploadCall({ method: 'tools/call', params: { name: 'more_tools', arguments: { tool: 'upload_file' } } }), true)
    assert.equal(isUploadCall({ method: 'tools/call', params: { name: 'import_folder', arguments: {} } }), false)
    assert.equal(isUploadCall([{ method: 'tools/call', params: { name: 'upload_file' } }]), false)
  })
})

describe('decideAgentUploads', () => {
  it('server on/off/never × workspace default/on/off', () => {
    const cases: [Parameters<typeof decideAgentUploads>[0], Parameters<typeof decideAgentUploads>[1], boolean, string][] = [
      ['on', null, true, 'server'],
      ['on', 'on', true, 'workspace'],
      ['on', 'off', false, 'workspace'],
      ['off', null, false, 'server'],
      ['off', 'on', true, 'workspace'],
      ['off', 'off', false, 'workspace'],
      ['never', null, false, 'never'],
      ['never', 'on', false, 'never'],
      ['never', 'off', false, 'never'],
    ]
    for (const [mode, ws, allowed, by] of cases) assert.deepEqual(decideAgentUploads(mode, ws), { allowed, by }, `${mode} × ${ws}`)
  })
})

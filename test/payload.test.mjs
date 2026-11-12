import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildTranscript,
  classifyToolCall,
  resolveOptions,
  resolveToolPath,
  toRepoRelative,
} from '../lib/index.js'

const options = resolveOptions()

test('classifies file-mutating tools', () => {
  assert.deepEqual(classifyToolCall('write', { file_path: 'src/a.js' }, options), {
    kind: 'file',
    path: 'src/a.js',
  })
  assert.deepEqual(classifyToolCall('edit', { file_path: 'D:/repo/a.js' }, options), {
    kind: 'file',
    path: 'D:/repo/a.js',
  })
  assert.deepEqual(classifyToolCall('str_replace_editor', { command: 'create', path: 'a.js' }, options), {
    kind: 'file',
    path: 'a.js',
  })
})

test('ignores read-only and unrelated tools', () => {
  assert.equal(classifyToolCall('read', { file_path: 'a.js' }, options), null)
  assert.equal(classifyToolCall('glob', { pattern: '*' }, options), null)
  assert.equal(classifyToolCall('grep', { pattern: 'x' }, options), null)
  assert.equal(classifyToolCall('str_replace_editor', { command: 'view', path: 'a.js' }, options), null)
  assert.equal(classifyToolCall('write', {}, options), null)
  assert.equal(classifyToolCall('write', { file_path: '' }, options), null)
})

test('classifies shell tools and extra tools', () => {
  assert.deepEqual(classifyToolCall('pwsh', { command: 'npm test' }, options), {
    kind: 'shell',
    command: 'npm test',
  })
  assert.deepEqual(classifyToolCall('bash', { command: 'make' }, options), {
    kind: 'shell',
    command: 'make',
  })
  assert.equal(classifyToolCall('pwsh', { command: '   ' }, options), null)

  const extended = resolveOptions({ extraShellTools: ['terminal_send'], extraFileTools: { apply_patch: 'path' } })
  assert.deepEqual(classifyToolCall('terminal_send', { command: 'ls' }, extended), {
    kind: 'shell',
    command: 'ls',
  })
  assert.deepEqual(classifyToolCall('apply_patch', { path: 'a.txt' }, extended), {
    kind: 'file',
    path: 'a.txt',
  })
})

test('skips background shell commands unless enabled', () => {
  assert.equal(classifyToolCall('pwsh', { command: 'npm run dev', run_in_background: true }, options), null)
  const enabled = resolveOptions({ trackBackgroundCommands: true })
  assert.deepEqual(classifyToolCall('pwsh', { command: 'npm run dev', run_in_background: true }, enabled), {
    kind: 'shell',
    command: 'npm run dev',
  })
})

test('expresses paths relative to the repository root', () => {
  assert.equal(toRepoRelative('D:/work/repo', 'D:/work/repo/src/a.js'), 'src/a.js')
  assert.equal(toRepoRelative('D:\\work\\repo', 'D:\\work\\repo\\a.js'), 'a.js')
  assert.equal(toRepoRelative('D:/work/repo', '/d/work/repo/a.js'.replace('/d/', 'D:/')), 'a.js')
  assert.equal(toRepoRelative('D:/work/repo', 'D:/other/a.js'), 'D:/other/a.js')
  assert.equal(toRepoRelative('D:/work/repo', 'D:/work/repo'), '.')
  assert.equal(toRepoRelative(undefined, 'D:/work/repo/a.js'), 'D:/work/repo/a.js')
})

test('resolves relative tool paths against the session directory', () => {
  assert.equal(resolveToolPath('D:/work/repo', 'src/a.js'), 'D:/work/repo/src/a.js')
  assert.equal(resolveToolPath('D:/work/repo', 'D:\\work\\repo\\a.js'), 'D:/work/repo/a.js')
  assert.equal(resolveToolPath('D:/work/repo', '/tmp/a.js'), '/tmp/a.js')
})

test('builds a transcript from real turns only', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'system prompt' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Fix the parser' }] },
    { role: 'user', source: { kind: 'notice' }, content: [{ type: 'text', text: 'injected context' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Looking at it' }] },
    { role: 'tool', source: { kind: 'tool' }, content: [{ type: 'text', text: 'tool output' }] },
  ]
  const transcript = buildTranscript(messages, options)
  assert.ok(transcript)
  assert.deepEqual(
    transcript.messages.map((entry) => [entry.type, entry.text]),
    [
      ['user', 'Fix the parser'],
      ['assistant', 'Looking at it'],
    ],
  )
})

test('keeps the first user turn and the newest messages under budget', () => {
  const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'first task' }] }]
  for (let index = 0; index < 50; index += 1) {
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `step ${index} ${'x'.repeat(40)}` }] })
  }
  const transcript = buildTranscript(messages, resolveOptions({ maxTranscriptMessages: 5, maxTranscriptBytes: 4096 }))
  assert.ok(transcript)
  assert.ok(transcript.messages.length <= 5)
  assert.equal(transcript.messages[0].text, 'first task')
  assert.match(transcript.messages.at(-1).text, /^step 49/)
})

test('returns no transcript for empty history', () => {
  assert.equal(buildTranscript([], options), undefined)
  assert.equal(buildTranscript(undefined, options), undefined)
})

test('honours GIT_AI_BINARY', () => {
  const previous = process.env.GIT_AI_BINARY
  process.env.GIT_AI_BINARY = 'D:/tools/git-ai.exe'
  try {
    assert.equal(resolveOptions({ binary: 'ignored' }).binary, 'D:/tools/git-ai.exe')
  } finally {
    if (previous === undefined) delete process.env.GIT_AI_BINARY
    else process.env.GIT_AI_BINARY = previous
  }
})

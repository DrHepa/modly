import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./model-downloader.ts', import.meta.url), 'utf8')

test('legacy SSE consumer flushes final unterminated done before accepting success', () => {
  assert.match(source, /buffer \+= decoder\.decode\(\)/)
  assert.match(source, /if \(buffer\) consumeLine\(buffer\)/)
  assert.match(source, /normalized\.progress\.percent === 100 && normalized\.progress\.status === 'done'[\s\S]*?completed = true/)
})

test('legacy SSE consumer fails closed on incomplete stream without weakening pause and cancel', () => {
  assert.match(source, /let completed = false/)
  assert.match(source, /let stopped = false/)
  assert.match(source, /normalized\.progress\.paused \|\| normalized\.progress\.cancelled[\s\S]*?stopped = true/)
  assert.match(source, /if \(!completed && !stopped\) \{[\s\S]*?code: 'incomplete_stream'[\s\S]*?retryable: true/)
})

test('HTTP target owner mismatch maps to non-retryable ModelAssetDownloadError', () => {
  assert.match(source, /typeof detail === 'string' && \/target owner\/i\.test\(detail\)/)
  assert.match(source, /code: 'target_owner_mismatch'[\s\S]*?stage: 'request'[\s\S]*?retryable: false/)
  assert.match(source, /if \(detail && typeof detail === 'object'[\s\S]*?retryable: failure\.retryable === true/)
})

test('normal HTTP, fetch, missing-stream and stall failures stay explicitly retryable', () => {
  assert.match(source, /code: 'http_error'[\s\S]*?retryable: true/)
  assert.match(source, /asRetryableDownloadError\(error, 'Manifest asset download request failed'\)/)
  assert.match(source, /code: 'missing_stream'[\s\S]*?retryable: true/)
  assert.match(source, /asRetryableDownloadError\(error, 'HuggingFace download stream failed'\)/)
  assert.match(source, /setTimeout\(\(\) => reject\(new Error\(.*Model download stalled/)
  assert.match(source, /await reader\.cancel\(\)\.catch\(\(\) => undefined\)/)
  assert.match(source, /abortController\.abort\(\)/)
})

test('permanent HTTP status failures cannot become retryable', () => {
  assert.match(source, /retryable: res\.status === 408 \|\| res\.status === 425 \|\| res\.status === 429 \|\| res\.status >= 500/)
  assert.match(source, /const transientStatus = res\.status === 408 \|\| res\.status === 425 \|\| res\.status === 429 \|\| res\.status >= 500/)
  assert.match(source, /retryable: failure\.retryable === true && transientStatus/)
})

test('stream consumer cleans reader and request when consumeLine raises', () => {
  assert.match(source, /for \(const line of lines\) consumeLine\(line\)[\s\S]*?catch \(error\) \{[\s\S]*?await reader\.cancel\(\)\.catch\(\(\) => undefined\)[\s\S]*?abortController\.abort\(\)/)
  assert.match(source, /for \(const line of lines\) consumeLine\(line\)[\s\S]*?catch \(error\) \{[\s\S]*?await reader\.cancel\(\)\.catch\(\(\) => undefined\)[\s\S]*?abortRequest\(\)/)
})

test('structured SSE stall timers are cleared after each read', () => {
  assert.match(source, /async function readWithTimeout\(\)[\s\S]*?finally \{[\s\S]*?clearTimeout\(timeout\)/)
})

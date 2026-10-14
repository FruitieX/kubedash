import { describe, expect, it } from 'vitest'
import { age, logLevel, shortImage, splitTimestamp } from './format'

describe('age', () => {
  const now = Date.parse('2026-10-14T12:00:00Z')
  it('formats compact durations', () => {
    expect(age('2026-10-14T11:59:30Z', now)).toBe('30s')
    expect(age('2026-10-14T11:15:00Z', now)).toBe('45m')
    expect(age('2026-10-13T12:00:00Z', now)).toBe('24h')
    expect(age('2026-10-01T12:00:00Z', now)).toBe('13d')
    expect(age(null, now)).toBe('–')
  })
})

describe('shortImage', () => {
  it('strips registry and shortens digests', () => {
    expect(
      shortImage(
        'ghcr.io/fruitiex/homectl:main@sha256:a8011a8354bc6f878ed6a5bed65e383b6a848bbb5c021881ae9ca867b29c33ca',
      ),
    ).toEqual({ name: 'homectl', tag: 'main@a8011a8' })
    expect(shortImage('busybox')).toEqual({ name: 'busybox', tag: 'latest' })
    expect(shortImage('localhost:5000/app:1.2')).toEqual({
      name: 'app',
      tag: '1.2',
    })
    expect(
      shortImage('ghcr.io/x/y:b5141327c7df2f53a03bdd0aa3f75386edfeedb1'),
    ).toEqual({ name: 'y', tag: 'b514132' })
  })
})

describe('logs', () => {
  it('detects levels near the start of lines', () => {
    expect(logLevel('[2026 ERROR server] boom')).toBe('error')
    expect(logLevel('level=warn msg="slow"')).toBe('warn')
    expect(logLevel('INFO started')).toBe('info')
    expect(logLevel('GET /health 200')).toBe(null)
  })
  it('splits timestamps', () => {
    expect(
      splitTimestamp('2026-10-14T05:10:27.842977513Z hello world'),
    ).toEqual({
      ts: '2026-10-14T05:10:27.842977513Z',
      text: 'hello world',
    })
    expect(splitTimestamp('plain')).toEqual({ ts: null, text: 'plain' })
  })
})

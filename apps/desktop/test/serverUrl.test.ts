import { describe, expect, it } from 'vitest';
import { MAX_BATCH_BODY_BYTES, MAX_BATCH_OPS, type BatchOp } from '@ternix/core/protocol';
import {
  chunkBatch,
  InvalidServerUrlError,
  isLoopbackHost,
  isTailnetHost,
  normalizeServerUrl,
  wsUrlFor,
} from '../src/main/client/index.js';

describe('normalizeServerUrl', () => {
  const accepted: [string, string][] = [
    // Tailscale MagicDNS names default to https (tailscale serve issues certificates).
    ['ternix.tail1234.ts.net', 'https://ternix.tail1234.ts.net'],
    ['  Ternix.Tail1234.TS.net/  ', 'https://ternix.tail1234.ts.net'],
    ['http://ternix.tail1234.ts.net:8080', 'http://ternix.tail1234.ts.net:8080'],
    ['example.com', 'https://example.com'],
    ['HTTPS://Vault.Example.COM/', 'https://vault.example.com'],
    ['example.com:8443', 'https://example.com:8443'],
    ['https://example.com:443/', 'https://example.com'],
    // Path prefix behind a reverse proxy; query and fragment dropped.
    ['https://example.com/ternix/', 'https://example.com/ternix'],
    ['example.com/ternix//?next=1#top', 'https://example.com/ternix'],
    ['192.168.1.10', 'https://192.168.1.10'],
    ['https://[2001:db8::1]:8443/', 'https://[2001:db8::1]:8443'],
    // Plain http where the link itself is protected or local.
    ['http://localhost:8080/', 'http://localhost:8080'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['http://127.9.9.9', 'http://127.9.9.9'],
    ['http://[::1]:8080', 'http://[::1]:8080'],
    ['http://100.101.102.103:8080', 'http://100.101.102.103:8080'],
    ['http://100.64.0.1', 'http://100.64.0.1'],
    ['http://100.127.255.254', 'http://100.127.255.254'],
    ['http://[fd7a:115c:a1e0::1234]:8080', 'http://[fd7a:115c:a1e0::1234]:8080'],
  ];

  it.each(accepted)('accepts %j as %j', (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });

  const rejected: [string, RegExp][] = [
    ['http://example.com', /unencrypted/],
    ['http://192.168.1.10:8080', /unencrypted/],
    ['http://100.128.0.1', /unencrypted/],
    ['http://100.63.255.255', /unencrypted/],
    ['http://[fd7a:115c:a1e1::1]', /unencrypted/],
    ['http://ts.net', /unencrypted/],
    ['http://ternix.ts.net.evil.example', /unencrypted/],
    ['http://0.0.0.0:8080', /unencrypted/],
    ['https://admin:hunter2@example.com', /user name or password/],
    ['https://admin@example.com', /user name or password/],
    ['ftp://example.com', /Unsupported/],
    ['ws://example.com', /Unsupported/],
    ['', /Enter the address/],
    ['   ', /Enter the address/],
    ['https://', /not a valid/],
    ['https://exa mple.com', /not a valid/],
  ];

  it.each(rejected)('rejects %j', (input, message) => {
    expect(() => normalizeServerUrl(input)).toThrow(InvalidServerUrlError);
    expect(() => normalizeServerUrl(input)).toThrow(message);
  });

  it('gives an error code the UI can switch on', () => {
    try {
      normalizeServerUrl('http://example.com');
      expect.unreachable();
    } catch (err) {
      expect((err as InvalidServerUrlError).code).toBe('invalid_server_url');
    }
  });
});

describe('host classification', () => {
  it('knows tailnet hosts', () => {
    expect(isTailnetHost('ternix.tail1234.ts.net')).toBe(true);
    expect(isTailnetHost('TERNIX.tail1234.ts.net.')).toBe(true);
    expect(isTailnetHost('100.64.0.0')).toBe(true);
    expect(isTailnetHost('100.127.1.1')).toBe(true);
    expect(isTailnetHost('[fd7a:115c:a1e0:ab12:4843:cd96:6258:b240]')).toBe(true);
    expect(isTailnetHost('fd7a:115c:a1e0::')).toBe(true);
    expect(isTailnetHost('ts.net')).toBe(false);
    expect(isTailnetHost('100.128.0.1')).toBe(false);
    expect(isTailnetHost('10.0.0.1')).toBe(false);
    expect(isTailnetHost('fd7a:115c:a1e1::1')).toBe(false);
    expect(isTailnetHost('example.com')).toBe(false);
  });

  it('knows loopback hosts', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isLoopbackHost('::2')).toBe(false);
    expect(isLoopbackHost('128.0.0.1')).toBe(false);
    expect(isLoopbackHost('localhost.example.com')).toBe(false);
  });
});

describe('wsUrlFor', () => {
  it('maps the scheme and appends the socket path', () => {
    expect(wsUrlFor('https://ternix.tail1234.ts.net')).toBe(
      'wss://ternix.tail1234.ts.net/api/v1/ws',
    );
    expect(wsUrlFor('https://example.com/ternix')).toBe('wss://example.com/ternix/api/v1/ws');
    expect(wsUrlFor('http://127.0.0.1:8080')).toBe('ws://127.0.0.1:8080/api/v1/ws');
  });
});

describe('chunkBatch', () => {
  const op = (i: number, size = 10): BatchOp => ({
    op: 'put',
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    ciphertext: 'v1.' + 'A'.repeat(size),
    key_version: 1,
    base_seq: null,
  });

  it('splits at MAX_BATCH_OPS', () => {
    const ops = Array.from({ length: 1201 }, (_, i) => op(i));
    const chunks = chunkBatch(ops, (o) => o);
    expect(chunks.map((c) => c.length)).toEqual([MAX_BATCH_OPS, MAX_BATCH_OPS, 201]);
    expect(chunks.flat()).toEqual(ops);
  });

  it('keeps every request body under MAX_BATCH_BODY_BYTES', () => {
    const ops = Array.from({ length: 50 }, (_, i) => op(i, 1024 * 1024));
    const chunks = chunkBatch(ops, (o) => o);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(JSON.stringify({ ops: chunk }))).toBeLessThanOrEqual(
        MAX_BATCH_BODY_BYTES,
      );
    }
    expect(chunks.flat()).toEqual(ops);
  });
});

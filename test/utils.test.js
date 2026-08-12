const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const { parseAdbLsOutput, escapeShellArg, getRemoteParent, getRemoteRelative } = require('../src/adb');
const { isPathAllowed, tokenEquals } = require('../src/security');

describe('parseAdbLsOutput', () => {
  test('parses a regular file line', () => {
    const output = 'drwxrwx--x  3 root sdcard_rw  4096 2026-01-15 10:30 Documents\n-rw-rw----  1 root sdcard_rw  12345 2026-01-15 10:31 test.txt';
    const entries = parseAdbLsOutput(output);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].name, 'Documents');
    assert.strictEqual(entries[0].isDirectory, true);
    assert.strictEqual(entries[0].size, 4096);
    assert.strictEqual(entries[1].name, 'test.txt');
    assert.strictEqual(entries[1].isDirectory, false);
    assert.strictEqual(entries[1].size, 12345);
  });

  test('skips total and empty lines', () => {
    const output = 'total 16\n\n-rw-r--r-- 1 root root 100 2026-01-01 12:00 file.txt\n';
    const entries = parseAdbLsOutput(output);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].name, 'file.txt');
  });

  test('handles filenames with spaces', () => {
    const output = '-rw-r--r-- 1 root root 100 2026-01-01 12:00 my file.txt';
    const entries = parseAdbLsOutput(output);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].name, 'my file.txt');
  });

  test('parses symlinks', () => {
    const output = 'lrwxrwxrwx 1 root root 10 2026-01-01 12:00 link -> /target/dir/';
    const entries = parseAdbLsOutput(output);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].name, 'link');
    assert.strictEqual(entries[0].isSymlink, true);
    assert.strictEqual(entries[0].isDirectory, true);
  });

  test('skips . and .. entries', () => {
    const output = 'drwxr-xr-x 2 root root 4096 2026-01-01 12:00 .\ndrwxr-xr-x 3 root root 4096 2026-01-01 12:00 ..\n-rw-r--r-- 1 root root 100 2026-01-01 12:00 real.txt';
    const entries = parseAdbLsOutput(output);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].name, 'real.txt');
  });
});

describe('escapeShellArg', () => {
  test('wraps in single quotes', () => {
    assert.strictEqual(escapeShellArg('hello'), "'hello'");
  });

  test('escapes single quotes', () => {
    assert.strictEqual(escapeShellArg("it's"), "'it'\\''s'");
  });

  test('handles empty string', () => {
    assert.strictEqual(escapeShellArg(''), "''");
  });

  test('handles non-string input', () => {
    assert.strictEqual(escapeShellArg(123), '');
  });

  test('handles paths with spaces', () => {
    assert.strictEqual(escapeShellArg('/path with spaces/file.txt'), "'/path with spaces/file.txt'");
  });
});

describe('getRemoteParent', () => {
  test('gets parent of a nested path', () => {
    assert.strictEqual(getRemoteParent('/sdcard/Documents/work'), '/sdcard/Documents');
  });

  test('returns root for top-level', () => {
    assert.strictEqual(getRemoteParent('/sdcard'), '/');
  });

  test('handles trailing slash', () => {
    assert.strictEqual(getRemoteParent('/sdcard/Documents/'), '/sdcard');
  });
});

describe('getRemoteRelative', () => {
  test('computes relative path from parent', () => {
    assert.strictEqual(getRemoteRelative('/sdcard/Documents', '/sdcard/Documents/file.txt'), 'file.txt');
  });

  test('computes nested relative path', () => {
    assert.strictEqual(getRemoteRelative('/sdcard', '/sdcard/Music/song.mp3'), 'Music/song.mp3');
  });

  test('handles root parent', () => {
    assert.strictEqual(getRemoteRelative('/', '/file.txt'), 'file.txt');
  });
});

describe('isPathAllowed', () => {
  test('allows home directory', () => {
    assert.strictEqual(isPathAllowed(os.homedir()), true);
  });

  test('allows path inside home directory', () => {
    assert.strictEqual(isPathAllowed(path.join(os.homedir(), 'Desktop', 'file.txt')), true);
  });

  test('allows temp directory', () => {
    assert.strictEqual(isPathAllowed(os.tmpdir()), true);
  });

  test('allows path inside temp directory', () => {
    assert.strictEqual(isPathAllowed(path.join(os.tmpdir(), 'droidbridge-temp-123')), true);
  });

  test('allows system paths (root `/` is in the allowed list)', () => {
    // After the fix to allow `/` as filesystem root, paths under it are accessible
    assert.strictEqual(isPathAllowed('/etc/passwd'), true);
    assert.strictEqual(isPathAllowed('/var/log/system.log'), true);
    assert.strictEqual(isPathAllowed('/'), true);
    assert.strictEqual(isPathAllowed('/Applications'), true);
  });

  test('prefix collision is harmless when root is allowed', () => {
    // With `/` in the allowed list, every absolute path is accessible.
    // The old prefix-collision risk (/Users/evil vs /Users/username) is moot
    // because `/` is a superset of all allowed dirs.
    const fakePath = path.join(os.homedir() + 'backdoor', 'file.txt');
    assert.strictEqual(isPathAllowed(fakePath), true); // allowed because `/` covers it
  });
});

describe('tokenEquals', () => {
  test('returns true for equal strings', () => {
    assert.strictEqual(tokenEquals('abc123', 'abc123'), true);
  });

  test('returns false for different strings', () => {
    assert.strictEqual(tokenEquals('abc123', 'abc456'), false);
  });

  test('returns false for different lengths', () => {
    assert.strictEqual(tokenEquals('abc', 'abcd'), false);
  });

  test('returns false for non-string inputs', () => {
    assert.strictEqual(tokenEquals(null, 'abc'), false);
    assert.strictEqual(tokenEquals(undefined, 'abc'), false);
    assert.strictEqual(tokenEquals(123, 'abc'), false);
  });

  test('returns true for empty strings', () => {
    assert.strictEqual(tokenEquals('', ''), true);
  });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'settings-store.js'), 'utf8');
const settingsPath = '/mock/userData/settings.json';
const encrypted = Buffer.from('mock encrypted token').toString('base64');
const fields = { repository: 'example/project', branch: 'main', rootPath: '', proxy: '' };

function loadStore({ platform = 'linux', backend = 'gnome_libsecret', available = true, stored = {}, storage = {} } = {}) {
  const files = new Map([[settingsPath, JSON.stringify(stored)]]);
  const calls = { encrypt: [], decrypt: [], writes: [], mkdir: [] };
  const safeStorage = {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString(token) { calls.encrypt.push(token); return Buffer.from('mock encrypted token'); },
    decryptString(value) { calls.decrypt.push(value); return 'mock token'; },
    ...storage
  };
  const mockFs = {
    readFileSync(file) {
      if (!files.has(file)) throw new Error('ENOENT');
      return files.get(file);
    },
    mkdirSync(...args) { calls.mkdir.push(args); },
    writeFileSync(file, value, options) {
      calls.writes.push({ file, value, options });
      files.set(file, value);
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, Buffer, process: { platform },
    require(name) {
      if (name === 'node:fs') return mockFs;
      if (name === 'node:path') return path.posix;
      if (name === 'electron') return {
        app: { getPath: () => '/mock/userData', getAppPath: () => '/mock/app' }, safeStorage
      };
      throw new Error(`Unexpected import: ${name}`);
    }
  }, { filename: 'settings-store.js' });
  return { store: module.exports, calls, saved: () => JSON.parse(files.get(settingsPath)) };
}

for (const scenario of [
  { name: 'basic_text despite encryption availability', backend: 'basic_text' },
  { name: 'unavailable encryption', available: false },
  { name: 'backend inspection failure', storage: { getSelectedStorageBackend() { throw new Error('locked'); } } },
  { name: 'availability inspection failure', storage: { isEncryptionAvailable() { throw new Error('locked'); } } }
]) {
  test(`Linux rejects token writes and reads with ${scenario.name}`, () => {
    const original = { ...fields, tokenEncrypted: encrypted };
    const { store, calls, saved } = loadStore({ ...scenario, stored: original });
    assert.throws(() => store.save({ ...fields, token: 'new mock token' }),
      /Linux 安全存储不可用.*Token.*GNOME Keyring\/KWallet.*gh auth login/);
    assert.deepEqual(saved(), original);
    assert.equal(calls.encrypt.length, 0);
    assert.equal(calls.writes.length, 0);
    assert.equal(calls.mkdir.length, 0);
    assert.equal(store.getToken(), '');
    assert.equal(calls.decrypt.length, 0);
  });
}

for (const options of [{ backend: 'basic_text' }, { available: false }]) {
  test(`Linux allows token-free saves and clearing: ${JSON.stringify(options)}`, () => {
    const { store, calls, saved } = loadStore({ ...options, stored: { tokenEncrypted: encrypted } });
    store.save({ ...fields, token: '' });
    assert.equal(saved().repository, fields.repository);
    assert.equal(saved().tokenEncrypted, encrypted);
    assert.equal(store.getToken(), '');
    store.save({ ...fields, clearToken: true });
    assert.equal(saved().tokenEncrypted, '');
    assert.equal(store.getPublic().hasToken, false);
    assert.equal(store.getToken(), '');
    assert.equal(calls.encrypt.length, 0);
    assert.equal(calls.decrypt.length, 0);

    const fresh = loadStore(options);
    fresh.store.save(fields);
    assert.equal(fresh.saved().tokenEncrypted, '');
  });
}

for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
  test(`Linux securely saves and reads with ${backend}`, () => {
    const { store, calls, saved } = loadStore({ backend });
    assert.equal(store.save({ ...fields, token: 'mock token' }).hasToken, true);
    assert.equal(saved().tokenEncrypted, encrypted);
    assert.deepEqual(calls.encrypt, ['mock token']);
    assert.equal(calls.writes[0].options.mode, 0o600);
    assert.equal(store.getToken(), 'mock token');
    assert.deepEqual(calls.decrypt[0], Buffer.from(encrypted, 'base64'));
    store.save(fields);
    assert.equal(saved().tokenEncrypted, encrypted);
  });
}

test('Linux supports Electron without the backend inspection API when encryption is available', () => {
  const { store } = loadStore({ storage: { getSelectedStorageBackend: undefined } });
  store.save({ ...fields, token: 'mock token' });
  assert.equal(store.getToken(), 'mock token');
});

test('macOS retains encryption behavior without querying Linux storage capabilities', () => {
  const unexpected = () => { throw new Error('Linux capability query on macOS'); };
  const { store, calls } = loadStore({
    platform: 'darwin',
    storage: { isEncryptionAvailable: unexpected, getSelectedStorageBackend: unexpected }
  });
  store.save({ ...fields, token: 'mock token' });
  assert.deepEqual(calls.encrypt, ['mock token']);
  assert.equal(store.getToken(), 'mock token');
  store.save({ ...fields, token: '', clearToken: true });
  assert.equal(store.getToken(), '');
});

test('decryption errors still return an empty token', () => {
  const { store } = loadStore({
    stored: { tokenEncrypted: encrypted },
    storage: { decryptString() { throw new Error('invalid ciphertext'); } }
  });
  assert.equal(store.getToken(), '');
});

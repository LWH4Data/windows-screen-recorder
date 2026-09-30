'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { RecordingStore } = require('../recording-store.cjs');

async function fixture(t, overrides) {
  const workspace = path.resolve(__dirname, '..', '..');
  const directory = await fs.mkdtemp(path.join(workspace, 'recording-store-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), workspace);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    store: new RecordingStore(overrides),
    destination: path.join(directory, 'recording.webm'),
  };
}

function wrapHandles(callback, extra = {}) {
  return {
    ...fs,
    ...extra,
    open: async (...args) => {
      const handle = await fs.open(...args);
      return callback(handle);
    },
  };
}

test('queued chunks preserve order, buffer snapshots and partial-write offsets', async (t) => {
  const wrappedFS = wrapHandles((handle) => ({
    write: async (buffer, offset, length, position) => {
      // Write at most two bytes to exercise the write-completely loop.
      await new Promise((resolve) => setTimeout(resolve, 2));
      return handle.write(buffer, offset, Math.min(2, length), position);
    },
    sync: () => handle.sync(), close: () => handle.close(),
  }));
  const { store, destination } = await fixture(t, { fs: wrappedFS });
  const recording = await store.begin(destination);
  const first = new Uint8Array(Buffer.from('FIRST'));
  const writes = [store.writeChunk(recording.id, first), store.writeChunk(recording.id, Buffer.from('next'))];
  first.fill(0);
  // finish must wait for writes already accepted into the queue.
  const completion = store.finish(recording.id);
  assert.deepEqual(await Promise.all(writes), [{ bytes: 5 }, { bytes: 9 }]);
  assert.deepEqual(await completion, { path: destination, bytes: 9 });
  assert.equal(await fs.readFile(destination, 'utf8'), 'FIRSTnext');
  await assert.rejects(fs.stat(`${destination}.recording`), { code: 'ENOENT' });
});

test('an empty recording is removed and cannot be published by a second finish', async (t) => {
  const { store, destination } = await fixture(t);
  const { id } = await store.begin(destination);
  await assert.rejects(store.finish(id), /녹화 데이터가 없어/);
  await assert.rejects(store.finish(id), /녹화 데이터가 없어/);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  await assert.rejects(fs.stat(`${destination}.recording`), { code: 'ENOENT' });
  assert.deepEqual(await store.abandon(id), { path: null, bytes: 0, partial: false });
});

test('a failed queued write poisons later writes and preserves exactly the bytes written', async (t) => {
  let calls = 0;
  const wrappedFS = wrapHandles((handle) => ({
    write: async (buffer, offset, length, position) => {
      calls += 1;
      if (calls === 2) return handle.write(buffer, offset, 2, position);
      if (calls >= 3) throw new Error('simulated disk full');
      return handle.write(buffer, offset, length, position);
    },
    sync: () => handle.sync(), close: () => handle.close(),
  }));
  const { store, destination } = await fixture(t, { fs: wrappedFS });
  const { id } = await store.begin(destination);
  const results = Promise.allSettled([
    store.writeChunk(id, Buffer.from('first')),
    store.writeChunk(id, Buffer.from('broken')),
    store.writeChunk(id, Buffer.from('must-not-be-retried')),
  ]);
  const failedFinish = assert.rejects(store.finish(id), /simulated disk full[\s\S]*부분 파일 보존 위치/);
  const settled = await results;
  await failedFinish;
  assert.deepEqual(settled.map((item) => item.status), ['fulfilled', 'rejected', 'rejected']);
  assert.equal(calls, 3, 'later queued chunks must never be written after failure');
  assert.equal(await fs.readFile(`${destination}.recording`, 'utf8'), 'firstbr');
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  await assert.rejects(store.finish(id), /simulated disk full/);
  assert.equal(calls, 3, 'finishing again must not replay any writes');
  assert.deepEqual(await store.abandon(id), { path: `${destination}.recording`, bytes: 7, partial: true });
});

test('finishing twice is idempotent; completed files survive abandon', async (t) => {
  let renames = 0;
  const { store, destination } = await fixture(t, { fs: {
    ...fs,
    rename: async (...args) => { renames += 1; return fs.rename(...args); },
  } });
  const { id } = await store.begin(destination);
  await store.writeChunk(id, Buffer.from('complete'));
  const firstFinish = store.finish(id);
  assert.equal(store.finish(id), firstFinish);
  assert.deepEqual(await firstFinish, { path: destination, bytes: 8 });
  assert.deepEqual(await store.finish(id), { path: destination, bytes: 8 });
  await assert.rejects(store.writeChunk(id, Buffer.from('late')), /이미 마무리/);
  assert.deepEqual(await store.abandon(id), { path: destination, bytes: 8, partial: false });
  assert.equal(renames, 1);
  assert.equal(await fs.readFile(destination, 'utf8'), 'complete');
});

test('abandon waits for accepted writes and preserves a partial recording', async (t) => {
  const { store, destination } = await fixture(t);
  const { id } = await store.begin(destination);
  const write = store.writeChunk(id, Buffer.from('recoverable'));
  const abandoned = store.abandon(id);
  await write;
  assert.deepEqual(await abandoned, { path: `${destination}.recording`, bytes: 11, partial: true });
  assert.equal(store.abandon(id), abandoned);
  await assert.rejects(store.writeChunk(id, Buffer.from('late')), /이미 마무리/);
  await assert.rejects(store.finish(id), /이미 중단/);
  assert.equal(await fs.readFile(`${destination}.recording`, 'utf8'), 'recoverable');
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});

test('abandon deletes an empty temporary file', async (t) => {
  const { store, destination } = await fixture(t);
  const { id } = await store.begin(destination);
  assert.deepEqual(await store.abandon(id), { path: null, bytes: 0, partial: false });
  await assert.rejects(fs.stat(`${destination}.recording`), { code: 'ENOENT' });
});

test('rename failure retains the recording and duplicate finish cannot retry it', async (t) => {
  let attempts = 0;
  const { store, destination } = await fixture(t, { fs: {
    ...fs,
    rename: async () => { attempts += 1; throw new Error('simulated rename denied'); },
  } });
  const { id } = await store.begin(destination);
  await store.writeChunk(id, Buffer.from('video'));
  await assert.rejects(store.finish(id), /simulated rename denied/);
  await assert.rejects(store.finish(id), /simulated rename denied/);
  assert.equal(attempts, 1);
  assert.equal(await fs.readFile(`${destination}.recording`, 'utf8'), 'video');
  assert.deepEqual(await store.abandon(id), { path: `${destination}.recording`, bytes: 5, partial: true });
});

test('existing destinations and temporary files are never overwritten', async (t) => {
  const { store, destination } = await fixture(t);
  await fs.writeFile(destination, 'old recording');
  await assert.rejects(store.begin(destination), /같은 이름의 파일/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'old recording');
  await fs.unlink(destination);
  await fs.writeFile(`${destination}.recording`, 'older partial');
  await assert.rejects(store.begin(destination), /같은 이름의 임시 녹화 파일/);
  assert.equal(await fs.readFile(`${destination}.recording`, 'utf8'), 'older partial');
});

test('a destination created during recording is preserved alongside the partial file', async (t) => {
  const { store, destination } = await fixture(t);
  const { id } = await store.begin(destination);
  await store.writeChunk(id, Buffer.from('new recording'));
  await fs.writeFile(destination, 'someone else saved here');
  await assert.rejects(store.finish(id), /같은 이름의 파일이 생겼습니다/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'someone else saved here');
  assert.equal(await fs.readFile(`${destination}.recording`, 'utf8'), 'new recording');
});

test('sync failure closes the handle and keeps the partial file for recovery', async (t) => {
  let closed = false;
  const wrappedFS = wrapHandles((handle) => ({
    write: (...args) => handle.write(...args),
    sync: async () => { throw new Error('simulated sync failure'); },
    close: async () => { await handle.close(); closed = true; },
  }));
  const { store, destination } = await fixture(t, { fs: wrappedFS });
  const { id } = await store.begin(destination);
  await store.writeChunk(id, Buffer.from('video'));
  await assert.rejects(store.finish(id), /simulated sync failure/);
  assert.equal(closed, true);
  assert.equal(await fs.readFile(`${destination}.recording`, 'utf8'), 'video');
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});

test('an uncertain failed write is preserved even when acknowledged byte count is zero', async (t) => {
  const wrappedFS = wrapHandles((handle) => ({
    write: async (...args) => {
      await handle.write(...args);
      throw new Error('write acknowledgement lost');
    },
    sync: () => handle.sync(), close: () => handle.close(),
  }));
  const { store, destination } = await fixture(t, { fs: wrappedFS });
  const { id } = await store.begin(destination);
  await assert.rejects(store.writeChunk(id, Buffer.from('unknown-but-on-disk')), /acknowledgement lost/);
  assert.deepEqual(await store.abandon(id), { path: `${destination}.recording`, bytes: 0, partial: true });
  assert.equal(await fs.readFile(`${destination}.recording`, 'utf8'), 'unknown-but-on-disk');
});

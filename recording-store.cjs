'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_CHUNK_BYTES = 32 * 1024 * 1024;

/**
 * Owns the recording file, including after the renderer disappears.
 * Each session has one queue. A failed write poisons that queue so no bytes
 * can be retried, duplicated or published as a completed recording.
 */
class RecordingStore {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    this.makeId = options.makeId || randomUUID;
    this.sessions = new Map();
  }

  async begin(destination) {
    if (typeof destination !== 'string' || !path.isAbsolute(destination)) {
      throw new Error('저장할 파일의 절대 경로가 필요합니다.');
    }
    if (!['.mp4', '.webm'].includes(path.extname(destination).toLowerCase())) {
      throw new Error('MP4 또는 WebM 파일로 저장해 주세요.');
    }
    if (await this.exists(destination)) {
      throw new Error('같은 이름의 파일이 있습니다. 다른 파일 이름을 선택해 주세요.');
    }

    const temporaryPath = `${destination}.recording`;
    let handle;
    try {
      handle = await this.fs.open(temporaryPath, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new Error('같은 이름의 임시 녹화 파일이 있습니다. 다른 파일 이름을 선택해 주세요.');
      }
      throw error;
    }
    const id = this.makeId();
    this.sessions.set(id, {
      id, path: destination, temporaryPath, handle, bytes: 0,
      state: 'open', queue: Promise.resolve(), failure: null,
      completion: null, abandonment: null,
    });
    return { id, path: destination };
  }

  writeChunk(id, input) {
    const session = this.requireSession(id);
    if (session.state !== 'open') {
      return Promise.reject(new Error('이미 마무리한 녹화에 데이터를 쓸 수 없습니다.'));
    }
    let data;
    if (input instanceof ArrayBuffer) data = Buffer.from(input);
    else if (ArrayBuffer.isView(input)) {
      // Copy before the asynchronous queue runs: callers may reuse a buffer.
      data = Buffer.from(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
    } else {
      return Promise.reject(new TypeError('녹화 데이터는 ArrayBuffer여야 합니다.'));
    }
    if (data.byteLength > MAX_CHUNK_BYTES) {
      return Promise.reject(new Error('한 번에 저장할 수 있는 녹화 데이터 크기를 초과했습니다.'));
    }
    // Buffer.from(ArrayBuffer) shares memory; take a snapshot for all inputs.
    data = Buffer.from(data);
    const operation = session.queue.then(async () => {
      if (session.failure) throw session.failure;
      try {
        let offset = 0;
        while (offset < data.byteLength) {
          const result = await session.handle.write(data, offset, data.byteLength - offset, null);
          if (!Number.isInteger(result.bytesWritten) || result.bytesWritten <= 0) {
            throw new Error('파일에 녹화 데이터를 저장하지 못했습니다.');
          }
          offset += result.bytesWritten;
          session.bytes += result.bytesWritten;
        }
        return { bytes: session.bytes };
      } catch (error) {
        session.failure ||= error;
        throw session.failure;
      }
    });
    // Keep a resolved tail and remember the first failure. Future operations
    // inspect failure, but no rejected background promise is left unhandled.
    session.queue = operation.catch(() => undefined);
    return operation;
  }

  finish(id) {
    const session = this.requireSession(id);
    if (session.completion) return session.completion;
    if (session.state !== 'open') {
      return Promise.reject(new Error('이 녹화는 이미 중단되었습니다.'));
    }
    session.state = 'finishing';
    session.completion = this.finishSession(session);
    return session.completion;
  }

  async finishSession(session) {
    await session.queue;
    await this.closeHandle(session);
    if (session.failure) {
      session.state = 'failed';
      throw this.preservationError(session);
    }
    if (!session.bytes) {
      session.state = 'empty';
      try {
        await this.fs.unlink(session.temporaryPath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          session.failure = error;
          session.state = 'failed';
          throw this.preservationError(session);
        }
      }
      throw new Error('녹화 데이터가 없어 파일을 저장하지 않았습니다.');
    }
    try {
      // Never replace a file created after the save dialog was opened.
      if (await this.exists(session.path)) {
        throw new Error('저장 위치에 같은 이름의 파일이 생겼습니다.');
      }
      await this.fs.rename(session.temporaryPath, session.path);
      session.state = 'completed';
      return { path: session.path, bytes: session.bytes };
    } catch (error) {
      session.failure ||= error;
      session.state = 'failed';
      throw this.preservationError(session);
    }
  }

  abandon(id) {
    const session = this.requireSession(id);
    if (session.abandonment) return session.abandonment;
    session.abandonment = this.abandonSession(session);
    return session.abandonment;
  }

  async abandonSession(session) {
    if (session.completion) {
      try {
        const completed = await session.completion;
        return { ...completed, partial: false };
      } catch {
        // finish already closed the handle, and preserved failed data.
      }
    } else {
      session.state = 'abandoning';
      await session.queue;
      await this.closeHandle(session);
    }
    const preserve = session.bytes > 0 || Boolean(session.failure);
    if (!preserve) {
      try {
        await this.fs.unlink(session.temporaryPath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          session.failure ||= error;
          session.state = 'failed';
          return { path: session.temporaryPath, bytes: session.bytes, partial: true };
        }
      }
    }
    session.state = preserve ? 'abandoned' : 'empty';
    return { path: preserve ? session.temporaryPath : null, bytes: session.bytes, partial: preserve };
  }

  async closeHandle(session) {
    if (!session.handle) return;
    const handle = session.handle;
    session.handle = null;
    try {
      if (session.bytes) await handle.sync();
    } catch (error) {
      session.failure ||= error;
    }
    try {
      await handle.close();
    } catch (error) {
      session.failure ||= error;
    }
  }

  async abandonAll() {
    const results = [];
    for (const session of this.sessions.values()) {
      if (['open', 'finishing', 'abandoning', 'failed'].includes(session.state)) {
        results.push(await this.abandon(session.id));
      }
    }
    return results;
  }

  requireSession(id) {
    if (typeof id !== 'string' || !this.sessions.has(id)) {
      throw new Error('녹화 세션을 찾을 수 없습니다.');
    }
    return this.sessions.get(id);
  }

  async exists(filePath) {
    try {
      await this.fs.lstat(filePath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  preservationError(session) {
    const reason = session.failure?.message || '저장 오류';
    return new Error(`녹화 파일 저장에 실패했습니다: ${reason}\n부분 파일 보존 위치: ${session.temporaryPath}`);
  }
}

module.exports = { RecordingStore, MAX_CHUNK_BYTES };

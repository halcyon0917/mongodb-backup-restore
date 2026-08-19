'use strict';

const fs = require('fs');
const zlib = require('zlib');
const { Transform } = require('stream');

// Absolute ceiling for a single BSON document (16 MB) plus headroom, used as a
// sanity check so a corrupt length prefix cannot make us allocate wildly.
const MAX_BSON_DOC_SIZE = 32 * 1024 * 1024;

// Characters that are illegal in Windows filenames, plus "%" so the encoding
// round-trips. This matches how mongodump escapes collection names.
const INVALID_FILENAME_CHARS = /[%<>:"/\\|?*\x00-\x1f]/g;

/** Encode a collection name so it is safe to use as a filename. */
function encodeCollectionFileName(name) {
  return String(name).replace(INVALID_FILENAME_CHARS, (char) => {
    return '%' + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
  });
}

/** Reverse encodeCollectionFileName. */
function decodeCollectionFileName(name) {
  return String(name).replace(/%([0-9A-Fa-f]{2})/g, (_match, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
}

/**
 * Incremental BSON document splitter.
 *
 * BSON documents are self-describing: the first four bytes are a little-endian
 * int32 total length. We buffer bytes as they arrive and hand back complete
 * documents, keeping any partial tail for the next chunk.
 */
class BsonDocumentSplitter {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  /** Feed a chunk in; returns the complete documents it made available. */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    const documents = [];
    let offset = 0;

    while (this.buffer.length - offset >= 4) {
      const size = this.buffer.readInt32LE(offset);
      if (size < 5 || size > MAX_BSON_DOC_SIZE) {
        throw new Error(
          `Corrupt BSON: document at byte ${offset} declares an invalid length of ${size}.`
        );
      }
      if (this.buffer.length - offset < size) break;
      documents.push(this.buffer.subarray(offset, offset + size));
      offset += size;
    }

    if (offset > 0) {
      this.buffer = Buffer.from(this.buffer.subarray(offset));
    }
    return documents;
  }

  /** Number of trailing bytes that did not form a complete document. */
  get pendingBytes() {
    return this.buffer.length;
  }
}

/** A pass-through stream that tallies the bytes flowing through it. */
function createByteCounter(onBytes) {
  let total = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (onBytes) onBytes(total, chunk.length);
      callback(null, chunk);
    },
  });
  Object.defineProperty(counter, 'bytes', { get: () => total });
  return counter;
}

/**
 * Open a write target for a .bson (or .bson.gz) file.
 * Returns a `write` function that honours backpressure and a `close` promise.
 */
function openBsonWriter(filePath, { gzip = false, gzipLevel = 6 } = {}) {
  const fileStream = fs.createWriteStream(filePath);
  let sink = fileStream;
  let gzipStream = null;

  if (gzip) {
    gzipStream = zlib.createGzip({ level: gzipLevel });
    gzipStream.pipe(fileStream);
    sink = gzipStream;
  }

  let failure = null;
  const recordFailure = (error) => {
    failure = failure || error;
  };
  fileStream.on('error', recordFailure);
  if (gzipStream) gzipStream.on('error', recordFailure);

  return {
    async write(chunk) {
      if (failure) throw failure;
      if (!sink.write(chunk)) {
        await new Promise((resolve, reject) => {
          const onDrain = () => {
            cleanup();
            resolve();
          };
          const onError = (error) => {
            cleanup();
            reject(error);
          };
          const cleanup = () => {
            sink.off('drain', onDrain);
            sink.off('error', onError);
          };
          sink.once('drain', onDrain);
          sink.once('error', onError);
        });
      }
    },

    async close() {
      await new Promise((resolve, reject) => {
        fileStream.once('close', () => (failure ? reject(failure) : resolve()));
        fileStream.once('error', reject);
        sink.end();
      });
    },

    async abort() {
      await new Promise((resolve) => {
        fileStream.once('close', resolve);
        sink.destroy();
        fileStream.destroy();
      }).catch(() => {});
    },
  };
}

/**
 * Async iterator over the raw BSON documents in a file.
 *
 * Yields `{ document, fileBytesRead }` so callers can drive progress off the
 * compressed on-disk size, which is what the user sees in Explorer.
 */
async function* readBsonDocuments(filePath, { gzip = false } = {}) {
  const counter = createByteCounter();
  let stream = fs.createReadStream(filePath).pipe(counter);
  if (gzip) {
    stream = stream.pipe(zlib.createGunzip());
  }

  const splitter = new BsonDocumentSplitter();

  for await (const chunk of stream) {
    for (const document of splitter.push(chunk)) {
      yield { document, fileBytesRead: counter.bytes };
    }
  }

  if (splitter.pendingBytes > 0) {
    throw new Error(
      `Corrupt or truncated BSON file: ${splitter.pendingBytes} trailing byte(s) in ${filePath}`
    );
  }
}

module.exports = {
  BsonDocumentSplitter,
  MAX_BSON_DOC_SIZE,
  createByteCounter,
  decodeCollectionFileName,
  encodeCollectionFileName,
  openBsonWriter,
  readBsonDocuments,
};

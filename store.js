'use strict';

/**
 * Storage layer.
 *
 * Persists the JSON database and uploaded files either to Google Cloud /
 * Firebase Storage (in production) or to the local disk (for development).
 *
 * Cloud mode is enabled by setting the STORAGE_BUCKET environment variable to
 * the name of your Firebase / Cloud Storage bucket (e.g. "my-app.appspot.com").
 * When it is not set, everything falls back to the local ./data and ./uploads
 * folders so the app keeps working during development.
 */

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const BUCKET_NAME = process.env.STORAGE_BUCKET || '';
const DB_OBJECT = process.env.STORAGE_DB_OBJECT || 'db.json';
const UPLOAD_PREFIX = (process.env.STORAGE_UPLOAD_PREFIX || 'uploads/').replace(/\/*$/, '/');
const USE_CLOUD = Boolean(BUCKET_NAME);

let bucket = null;
if (USE_CLOUD) {
  // Lazily required so local dev never needs the cloud SDK loaded.
  const { Storage } = require('@google-cloud/storage');
  bucket = new Storage().bucket(BUCKET_NAME);
}

// Serialize database writes within this instance to avoid read-modify-write
// races corrupting the whole-database JSON blob.
let writeChain = Promise.resolve();

function withWriteLock(task) {
  const run = writeChain.then(task, task);
  // Swallow errors on the chain itself so one failed write cannot poison later writes.
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

async function ensureLocalDirs() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
}

/** Whether the database has been created yet. */
async function dbExists() {
  if (USE_CLOUD) {
    const [exists] = await bucket.file(DB_OBJECT).exists();
    return exists;
  }
  return fs.existsSync(DB_FILE);
}

/** Read and parse the whole database. Throws if it does not exist. */
async function loadDb() {
  if (USE_CLOUD) {
    const [contents] = await bucket.file(DB_OBJECT).download();
    return JSON.parse(contents.toString('utf8'));
  }
  return JSON.parse(await fs.promises.readFile(DB_FILE, 'utf8'));
}

/** Persist the whole database atomically. */
function saveDb(db) {
  const payload = JSON.stringify(db, null, 2);
  return withWriteLock(async () => {
    if (USE_CLOUD) {
      await bucket.file(DB_OBJECT).save(payload, {
        resumable: false,
        contentType: 'application/json; charset=utf-8',
        metadata: { cacheControl: 'no-store' }
      });
      return;
    }
    await ensureLocalDirs();
    const temp = DB_FILE + '.tmp';
    await fs.promises.writeFile(temp, payload);
    await fs.promises.rename(temp, DB_FILE);
  });
}

/** Store an uploaded file's bytes under its stored name. */
async function putUpload(storedName, buffer, mimeType = 'application/octet-stream') {
  if (USE_CLOUD) {
    await bucket.file(UPLOAD_PREFIX + storedName).save(buffer, {
      resumable: false,
      contentType: mimeType,
      metadata: { cacheControl: 'private, no-store' }
    });
    return;
  }
  await ensureLocalDirs();
  await fs.promises.writeFile(path.join(UPLOAD_DIR, storedName), buffer);
}

/** Whether an uploaded file exists. */
async function uploadExists(storedName) {
  if (USE_CLOUD) {
    const [exists] = await bucket.file(UPLOAD_PREFIX + storedName).exists();
    return exists;
  }
  return fs.existsSync(path.join(UPLOAD_DIR, storedName));
}

/** A readable stream of an uploaded file's bytes. */
function getUploadStream(storedName) {
  if (USE_CLOUD) {
    return bucket.file(UPLOAD_PREFIX + storedName).createReadStream();
  }
  const filePath = path.join(UPLOAD_DIR, storedName);
  const resolved = path.normalize(filePath);
  if (!resolved.startsWith(UPLOAD_DIR)) {
    return Readable.from([]);
  }
  return fs.createReadStream(resolved);
}

module.exports = {
  USE_CLOUD,
  BUCKET_NAME,
  ensureLocalDirs,
  dbExists,
  loadDb,
  saveDb,
  putUpload,
  uploadExists,
  getUploadStream
};

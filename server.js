#!/usr/bin/env node
/**
 * server.js — File Catalog Search API + Scanner (SQLite edition)
 *
 * Usage:
 *   node server.js
 *
 * Environment variables:
 *   DB_PATH   — path to SQLite file (default: /data/filecatalog.db)
 *   PORT      — port to listen on  (default: 3030)
 *   API_HOST  — hostname/IP the browser uses to reach the API (default: localhost)
 *
 * Install deps:
 *   npm install express better-sqlite3 cors
 */

'use strict';

const express       = require('express');
const Database      = require('better-sqlite3');
const cors          = require('cors');
const path          = require('path');
const fs            = require('fs');
const crypto        = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────
const PORT     = parseInt(process.env.PORT     || '3030',        10);
const API_HOST = process.env.API_HOST          || 'localhost';
const DB_PATH  = process.env.DB_PATH           || '/data/filecatalog.db';

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ── Database setup ────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);

// Performance pragmas
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// Auto-create schema on first run
db.exec(`
  CREATE TABLE IF NOT EXISTS volumes (
    volume_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    volume_name TEXT    NOT NULL UNIQUE,
    root_path   TEXT    NOT NULL,
    unc_path    TEXT,
    scanned_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS files (
    file_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    volume_id   INTEGER NOT NULL,
    filename    TEXT    NOT NULL,
    path        TEXT    NOT NULL,
    file_size   INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (volume_id) REFERENCES volumes (volume_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_files_volume   ON files (volume_id);
  CREATE INDEX IF NOT EXISTS idx_files_filename ON files (filename);
  CREATE INDEX IF NOT EXISTS idx_files_path     ON files (path);
`);

console.log(`Database: ${DB_PATH}`);

// ── Prepared statements ───────────────────────────────────────────────────────
const stmts = {
  upsertVolume: db.prepare(`
    INSERT INTO volumes (volume_name, root_path, unc_path, scanned_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(volume_name) DO UPDATE SET
      root_path  = excluded.root_path,
      unc_path   = excluded.unc_path,
      scanned_at = excluded.scanned_at
  `),
  getVolume:    db.prepare('SELECT volume_id FROM volumes WHERE volume_name = ?'),
  clearFiles:   db.prepare('DELETE FROM files WHERE volume_id = ?'),
  deleteDs:     db.prepare("DELETE FROM files WHERE volume_id = ? AND filename = '.DS_Store'"),
  deleteVolume: db.prepare('DELETE FROM volumes WHERE volume_id = ?'),
  getVolById:   db.prepare('SELECT volume_name FROM volumes WHERE volume_id = ?'),
  insertFile:   db.prepare('INSERT INTO files (volume_id, filename, path, file_size) VALUES (?, ?, ?, ?)'),
};

// Batch insert using a transaction — dramatically faster than individual inserts
const insertBatch = db.transaction((volumeId, batch) => {
  for (const { filename, fullPath, size } of batch) {
    stmts.insertFile.run(volumeId, filename, fullPath, size);
  }
});

// ── In-memory job store ───────────────────────────────────────────────────────
const jobs = {};

// ── Walk helper ───────────────────────────────────────────────────────────────
async function* walk(rootDir) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        let size = 0;
        try {
          const stat = await fs.promises.stat(fullPath);
          size = stat.size;
        } catch { /* skip */ }
        yield { filename: entry.name, fullPath, size };
      }
    }
  }
}

// ── Scan runner (background) ──────────────────────────────────────────────────
async function runScan(jobId, rootPath, volumeName, uncPath) {
  const job       = jobs[jobId];
  const BATCH_SIZE = 1000;

  try {
    // Upsert volume
    stmts.upsertVolume.run(volumeName, rootPath, uncPath || null);
    const { volume_id } = stmts.getVolume.get(volumeName);

    // Clear existing files for this volume
    stmts.clearFiles.run(volume_id);

    let batch      = [];
    let totalFiles = 0;
    let totalBytes = 0;

    for await (const file of walk(rootPath)) {
      batch.push(file);
      totalFiles++;
      totalBytes   += file.size;
      job.files     = totalFiles;
      job.current   = file.fullPath;

      if (batch.length >= BATCH_SIZE) {
        insertBatch(volume_id, batch);
        batch = [];
      }
    }

    // Flush remainder
    if (batch.length > 0) insertBatch(volume_id, batch);

    // Clean up .DS_Store entries
    const { changes: dsCount } = stmts.deleteDs.run(volume_id);

    job.status     = 'done';
    job.files      = totalFiles;
    job.totalBytes = totalBytes;
    job.dsRemoved  = dsCount;
    job.current    = null;

  } catch (err) {
    job.status = 'error';
    job.error  = err.message;
    console.error('Scan error:', err);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/config
app.get('/api/config', (req, res) => {
  res.json({ apiBase: `http://${API_HOST}:${PORT}` });
});

// GET /api/volumes
app.get('/api/volumes', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT v.volume_id, v.volume_name, v.root_path, v.unc_path, v.scanned_at,
             COUNT(f.file_id) AS file_count
      FROM volumes v
      LEFT JOIN files f ON f.volume_id = v.volume_id
      GROUP BY v.volume_id
      ORDER BY v.volume_name
    `).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/browse?path=/mnt
app.get('/api/browse', (req, res) => {
  const dirPath = req.query.path || '/mnt';
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory())
      .map(e => ({ name: e.name, path: path.join(dirPath, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ current: dirPath, parent: path.dirname(dirPath), dirs });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/scan
app.post('/api/scan', (req, res) => {
  const { path: scanPath, volume, uncPath } = req.body;

  if (!scanPath || !volume) {
    return res.status(400).json({ error: 'path and volume are required' });
  }
  if (!fs.existsSync(scanPath)) {
    return res.status(400).json({ error: `Path not found: ${scanPath}` });
  }

  const jobId = crypto.randomBytes(6).toString('hex');
  jobs[jobId] = { status: 'running', files: 0, current: null, error: null };

  runScan(jobId, scanPath, volume, uncPath || '');
  res.json({ jobId });
});

// GET /api/scan/:jobId
app.get('/api/scan/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// DELETE /api/volumes/:id
app.delete('/api/volumes/:id', (req, res) => {
  const volumeId = parseInt(req.params.id, 10);
  if (!volumeId) return res.status(400).json({ error: 'Invalid volume ID' });

  try {
    const vol = stmts.getVolById.get(volumeId);
    if (!vol) return res.status(404).json({ error: 'Volume not found' });

    stmts.deleteVolume.run(volumeId);
    res.json({ deleted: true, volume_name: vol.volume_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/search
app.get('/api/search', (req, res) => {
  const q        = (req.query.q || '').trim();
  const volumeId = req.query.volume_id ? parseInt(req.query.volume_id, 10) : null;
  const page     = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limit    = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
  const offset   = (page - 1) * limit;

  if (q.length < 1) {
    return res.json({ results: [], total: 0, page, limit });
  }

  try {
    const likeVal = (q === '*' || q === '%2A' || q === '') ? '%' : `%${q}%`;
    const field   = req.query.field || 'filename';

    let params = [likeVal];
    let conditions;

    if (field === 'path') {
      conditions = ['f.path LIKE ?'];
    } else if (field === 'both') {
      conditions = ['(f.filename LIKE ? OR f.path LIKE ?)'];
      params.push(likeVal);
    } else {
      conditions = ['f.filename LIKE ?'];
    }

    const fileTypes = {
      video:    ['mp4','mkv','avi','mov','ts','wmv','m4v','mpg','mpeg','m2ts'],
      audio:    ['mp3','flac','wav','aac','m4a','ogg','wma'],
      image:    ['jpg','jpeg','png','gif','bmp','tiff','webp','raw'],
      document: ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','csv'],
    };

    const fileType = req.query.file_type || 'all';
    if (fileType !== 'all' && fileTypes[fileType]) {
      const exts         = fileTypes[fileType];
      const placeholders = exts.map(() => '?').join(', ');
      conditions.push(`LOWER(SUBSTR(f.filename, INSTR(f.filename, '.') + 1)) IN (${placeholders})`);
      params.push(...exts);
    }

    if (volumeId) {
      conditions.push('f.volume_id = ?');
      params.push(volumeId);
    }

    const where = conditions.join(' AND ');

    // Count only on page 1
    let total;
    if (page === 1) {
      const row = db.prepare(`SELECT COUNT(*) AS total FROM files f WHERE ${where}`).get(params);
      total = row.total;
    } else {
      total = parseInt(req.query.known_total || '0', 10);
    }

    const rows = db.prepare(`
      SELECT f.file_id, f.filename, f.path, f.file_size,
             v.volume_name, v.root_path, v.unc_path
      FROM files f
      JOIN volumes v ON f.volume_id = v.volume_id
      WHERE ${where}
      ORDER BY f.filename
      LIMIT ? OFFSET ?
    `).all([...params, limit, offset]);

    // Translate UNRAID paths to UNC paths where available
    const results = rows.map(row => {
      if (row.unc_path && row.root_path && row.path.startsWith(row.root_path)) {
        const relative      = row.path.slice(row.root_path.length);
        const uncNorm       = row.unc_path.replace(/\//g, '\\').replace(/\\$/, '');
        const relNorm       = relative.replace(/\//g, '\\');
        row.display_path    = uncNorm + relNorm;
      } else {
        row.display_path = row.path;
      }
      return row;
    });

    res.json({ results, total, page, limit });

  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve static files
app.use(express.static(path.join(__dirname)));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`File Catalog running → http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`API Host: ${API_HOST}`);
});

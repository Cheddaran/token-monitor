'use strict';

// Per-platform file watcher.
//
// macOS: one `fs.watch(dir, { recursive: true })` per top-level root. The
// recursive form is FSEvents-backed on darwin — one handle per root covers
// the entire subtree, no per-directory descriptor allocation. This is the
// change that brings the installed app's memory from ~2.2 GB to <1 GB on
// directories the size of OpenClaw's `~/.openclaw/agents/` (~9,700 dirs,
// ~22,300 files), where chokidar's per-dir model falls back to polling and
// pins the native allocator high-water.
//
// Linux/Windows or any user opt-in to polling: fall back to chokidar, which
// is the only option that supports polling, atomic-write stability, and
// cross-platform inotify/ReadDirectoryChangesW semantics. fs.watch's
// recursive form is documented as not fully supported on Linux, so it is
// not a drop-in there.
//
// Event protocol mirrors chokidar's `('all', event, filePath)` shape so the
// existing collector logic (`handleWatchEvent`, `clientsForWatchPath`,
// `isQoderCnSelfWatchEvent`) is unchanged.

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const { watcherOptions, watchIgnoreMatcher } = require('./collector');

function shouldUseNativeWatcher(usePolling) {
  // macOS only, and only when polling is NOT requested. The polling override
  // (`TOKEN_MONITOR_WATCH_POLLING` and the sticky ENOSPC/EMFILE/ENFILE fallback
  // in `handleWatchError`) must still flip us back to chokidar on darwin, since
  // fs.watch has no polling mode.
  return process.platform === 'darwin' && usePolling !== true;
}

function createNativeWatcher(dirs, clients) {
  const emitter = new EventEmitter();
  const ignore = watchIgnoreMatcher(clients);
  const watchers = [];
  let ready = false;
  let failed = false;

  emitter.on('error', () => { failed = true; });

  for (const dir of dirs) {
    let watcher;
    try {
      watcher = fs.watch(dir, { recursive: true, persistent: false }, (eventType, filename) => {
        // Some FSEvents deliveries (root removal, race on close) come with a
        // null filename; nothing to attribute, drop them.
        if (!filename) return;
        const fullPath = path.join(dir, filename);
        // fs.watch has no `ignored` option. The matcher is a pure function
        // of the path (per its contract), so applying it post-event matches
        // what chokidar would have done at watch creation.
        if (ignore && !ignore(fullPath)) return;
        // FSEvents does not distinguish add / change / unlink in `eventType`
        // (rename covers both, change covers content). `handleWatchEvent`
        // uses the event only in a log-string (`watch:${event}:${basename}`),
        // so a synthetic `change` keeps attribution correct without losing
        // observable behaviour.
        emitter.emit('all', 'change', fullPath);
      });
    } catch (error) {
      // Setup-time failures (ENOENT, EACCES) — forward to the host so the
      // ENOSPC/EMFILE/ENFILE sticky fallback in `handleWatchError` sees the
      // real code and keeps unrelated roots up if only one dir is broken.
      emitter.emit('error', error);
      continue;
    }
    watcher.on('error', (error) => emitter.emit('error', error));
    watchers.push(watcher);
  }

  // All handles are open synchronously after construction. Fire ready on
  // the next microtask so callers see consistent ordering with the chokidar
  // path (which also reports ready asynchronously).
  queueMicrotask(() => {
    if (failed || ready) return;
    ready = true;
    emitter.emit('ready');
  });

  return Object.assign(emitter, {
    kind: 'native',
    async close() {
      for (const watcher of watchers) {
        try { watcher.close(); } catch (_) { /* teardown must not throw */ }
      }
    }
  });
}

function createChokidarWatcher(dirs, clients, options) {
  const { usePolling } = options;
  // Required lazily: tests stub chokidar via require interception, and the
  // worker-hosted run never wants to load chokidar on the main thread.
  const chokidar = require('chokidar');
  const instance = chokidar.watch(
    dirs,
    watcherOptions(usePolling === true, watchIgnoreMatcher(clients))
  );
  // Re-emit chokidar's events under the standard event names. chokidar's
  // own error/ready handling differs (it surfaces a `failed` flag via
  // close), so we keep its instance untouched and forward through an
  // EventEmitter that callers wire the same way as the native side.
  const emitter = new EventEmitter();
  instance.on('all', (event, filePath) => emitter.emit('all', event, filePath));
  instance.on('error', (error) => emitter.emit('error', error));
  instance.on('ready', () => emitter.emit('ready'));

  return Object.assign(emitter, {
    kind: 'chokidar',
    async close() {
      try { await instance.close(); } catch (_) { /* teardown must not throw */ }
    }
  });
}

function createPlatformWatcher(config) {
  const { dirs, clients, usePolling } = config;
  if (shouldUseNativeWatcher(usePolling)) {
    return createNativeWatcher(dirs, clients);
  }
  return createChokidarWatcher(dirs, clients, { usePolling });
}

module.exports = {
  createPlatformWatcher,
  shouldUseNativeWatcher,
  createNativeWatcher,
  createChokidarWatcher
};

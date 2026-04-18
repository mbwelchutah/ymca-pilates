// Atomic JSON writer.
//
// Writes JSON to `<path>.tmp` and then `fs.renameSync` into place so a
// process kill mid-write can never leave the destination file truncated or
// empty. The destination either reflects the previous good copy or the new
// fully-serialised payload — never anything in between.

const fs   = require('fs');
const path = require('path');

function writeJsonAtomic(filePath, data, { spaces = 2 } = {}) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const json   = JSON.stringify(data, null, spaces);
  const tmp    = `${filePath}.tmp`;

  // Open + write + fsync the tmp file so its bytes are durable on disk
  // before we rename. Without fsync, a crash between rename() and the OS
  // flushing the data blocks could still surface as a zero-length file
  // on next boot. fsync itself is best-effort — some filesystems do not
  // support it and will throw EINVAL, which is non-fatal here.
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, json);
    try { fs.fsyncSync(fd); } catch (_) { /* fsync may not be supported */ }
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
  }

  fs.renameSync(tmp, filePath);
}

module.exports = { writeJsonAtomic };

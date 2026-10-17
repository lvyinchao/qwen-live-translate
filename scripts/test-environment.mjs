import path from 'node:path';

/** Keep isolated fixtures usable without inheriting provider keys, live-test flags
 * or another checkout's executable search paths. Never print the source env. */
export function isolatedTestEnv(overrides = {}, source = process.env) {
  const allowed = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SYSTEMROOT',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'CI',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_CACHE_HOME',
    'PLAYWRIGHT_BROWSERS_PATH',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
  ];
  const clean = {};
  for (const name of allowed) if (source[name] !== undefined) clean[name] = source[name];
  if (clean.PATH)
    clean.PATH = clean.PATH.split(path.delimiter)
      .filter((part) => !/[\\/]node_modules[\\/]\.bin[\\/]?$/.test(part))
      .join(path.delimiter);
  return { ...clean, ...overrides };
}

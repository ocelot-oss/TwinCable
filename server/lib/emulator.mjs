// External emulators: detection, one-click install from GitHub releases, launching.
// The integrated emulator (EmulatorJS inside the app) needs none of this.
import { existsSync, mkdirSync, writeFileSync, readdirSync, rmSync, cpSync, statSync, chmodSync, readFileSync } from 'node:fs';
import { join, basename, dirname, isAbsolute, resolve, posix, win32 } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { TOOLS_DIR } from './paths.mjs';
import { httpError, renameRetry, safeFileName } from './fsutil.mjs';
import { extractArchiveAsync } from './archive.mjs';

// assets: which file of the emulator's latest GitHub release to download – per platform, and per architecture
// where the project builds for several (an arm64 Windows PC runs the x64 build of mGBA through emulation). On Linux
// both ship AppImages (melonDS inside a zip as melonDS-x86_64.AppImage, mGBA as mGBA-0.10.5-appimage-x64.appimage).
// exe: the program file names the app accepts – the official builds and, on Linux, the distribution packages
// (melonDS, mgba-qt) and Flathub's launchers (net.kuribo64.melonDS, io.mgba.mGBA).
export const EMULATORS = {
  melonds: {
    name: 'melonDS',
    systems: ['nds'],
    repo: 'melonDS-emu/melonDS',
    live: 'arm9', // optional ARM9 debugger, with battery save fallback
    assets: { darwin: /macOS-universal\.zip$/i, win32: { x64: /windows-x86_64\.zip$/i, arm64: /windows-aarch64\.zip$/i }, linux: { x64: /appimage-x86_64\.zip$/i, arm64: /appimage-aarch64\.zip$/i } },
    app: /^melonDS.*\.app$/i,
    exe: /^(?:melonDS(?:\.exe)?|melonDS[\w.+-]*\.AppImage|net\.kuribo64\.melonDS)$/i,
  },
  mgba: {
    name: 'mGBA',
    systems: ['gb', 'gbc', 'gba'],
    repo: 'mgba-emu/mgba',
    live: 'script', // Lua bridge streams the party in real time
    assets: { darwin: /-macos\.dmg$/i, win32: /-win64\.7z$/i, linux: { x64: /appimage-x64\.appimage$/i, arm64: /appimage-arm64\.appimage$/i } },
    app: /^mGBA\.app$/i,
    exe: /^(?:mGBA(?:\.exe)?|mgba-qt|mGBA[\w.+-]*\.AppImage|io\.mgba\.mGBA)$/i,
  },
  // Nintendo 3DS. Live data through its RPC server (server/lib/azahar.mjs) – switched on from the play view.
  azahar: {
    name: 'Azahar',
    systems: ['3ds'],
    repo: 'azahar-emu/azahar',
    live: 'rpc',
    assets: { darwin: /^azahar-macos-universal-[\w.]+\.zip$/i, win32: { x64: /^azahar-windows-msvc-[\w.]+\.zip$/i }, linux: { x64: /^azahar\.AppImage$/i } },
    app: /^Azahar\.app$/i,
    exe: /^(?:azahar(?:\.exe)?|azahar[\w.+-]*\.AppImage|org\.azahar_emu\.Azahar)$/i,
  },
};

/**
 * Release-asset patterns for an emulator on this platform / architecture, best first: the native build, then the
 * x64 one (Windows on ARM and macOS run x64 builds through emulation) – a release without an arm64 build still
 * installs. Empty when there is no build for the platform at all.
 */
export function assetPatterns(id, platform = process.platform, arch = process.arch) {
  const a = EMULATORS[id]?.assets?.[platform];
  if (!a) return [];
  if (a instanceof RegExp) return [a];
  return [...new Set([a[arch], a.x64].filter(Boolean))];
}

/** The asset of a GitHub release to install: the first pattern that matches one of its files. */
export function pickAsset(assets, id, platform = process.platform, arch = process.arch) {
  for (const pattern of assetPatterns(id, platform, arch)) {
    const hit = (assets || []).find((a) => pattern.test(a.name));
    if (hit) return hit;
  }
  return null;
}

/** Where the official Windows installers put the emulators (mGBA's installer; melonDS only ships a zip). */
export function windowsSystemPaths(id, env = process.env) {
  const bases = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  const exe = id === 'mgba' ? ['mGBA', 'mGBA.exe'] : id === 'melonds' ? ['melonDS', 'melonDS.exe'] : id === 'azahar' ? ['Azahar', 'azahar.exe'] : null;
  return exe ? bases.map((b) => join(b, ...exe)) : [];
}

/**
 * Where Linux installs put the emulators: AppImages in ~/Applications (EmuDeck on the Steam Deck, AppImageLauncher),
 * the distribution's packages, and Flatpak's launchers (system-wide and per user). Pure – posix paths for `home`.
 */
export function linuxSystemPaths(id, home = process.env.HOME || '') {
  const names = {
    melonds: { appimage: ['melonDS.AppImage', 'melonDS-x86_64.AppImage'], bin: ['melonDS'], flatpak: 'net.kuribo64.melonDS' },
    mgba: { appimage: ['mGBA.AppImage', 'mgba.AppImage'], bin: ['mgba-qt'], flatpak: 'io.mgba.mGBA' },
    azahar: { appimage: ['azahar.AppImage', 'Azahar.AppImage'], bin: ['azahar'], flatpak: 'org.azahar_emu.Azahar' },
  }[id];
  if (!names) return [];
  const h = (...p) => (home && posix.isAbsolute(home) ? [posix.join(home, ...p)] : []);
  return [
    ...names.appimage.flatMap((n) => h('Applications', n)),
    ...names.bin.flatMap((n) => ['/usr/bin', '/usr/local/bin', '/usr/games'].map((d) => posix.join(d, n))),
    ...h('.local', 'share', 'flatpak', 'exports', 'bin', names.flatpak),
    posix.join('/var/lib/flatpak/exports/bin', names.flatpak),
  ];
}

const dirFor = (id) => join(TOOLS_DIR, 'emulators', id);

function findIn(dir, predicate, depth = 3) {
  if (!existsSync(dir) || depth < 0) return null;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (predicate(name, p)) return p;
    if (!name.endsWith('.app')) {
      try {
        const sub = findIn(p, predicate, depth - 1);
        if (sub) return sub;
      } catch {
        // file, not a directory
      }
    }
  }
  return null;
}

/**
 * A user-chosen emulator location is only accepted if it really looks like that emulator: an absolute path to
 * an `.app` bundle (directory) or an executable whose file name matches the emulator (mGBA / melonDS …).
 * Anything else – a shell script, /bin/sh, a ROM – is ignored, so a tampered config can't run arbitrary programs.
 */
export function validCustomPath(id, p) {
  const emu = EMULATORS[id];
  if (!emu || typeof p !== 'string' || !p || p.length > 4096 || /[\0\r\n]/.test(p) || !isAbsolute(p)) return null;
  const abs = resolve(p);
  const name = basename(abs.replace(/[\\/]+$/, ''));
  let st;
  try {
    st = statSync(abs);
  } catch {
    return null;
  }
  if (/\.app$/i.test(name)) return process.platform === 'darwin' && st.isDirectory() && emu.app.test(name) ? abs : null;
  return st.isFile() && emu.exe.test(name) ? abs : null;
}

/**
 * melonDS's own config files, most specific first: next to the program (a portable melonDS – the Windows zip keeps its
 * settings there), then the user's config folder (Qt's AppConfigLocation: ~/Library/Preferences/melonDS on a Mac,
 * ~/.config/melonDS on Linux, AppData on Windows). melonDS 1.x writes melonDS.toml, 0.9.x melonDS.ini.
 */
export function melonConfigFiles({ exePath = null, platform = process.platform, env = process.env } = {}) {
  const P = platform === 'win32' ? win32 : posix;
  const home = env.HOME || env.USERPROFILE || '';
  const dirs = [];
  if (exePath && !/\.app$/i.test(exePath)) dirs.push(P.dirname(exePath)); // (a Mac app keeps none in its bundle)
  if (platform === 'darwin') dirs.push(P.join(home, 'Library', 'Preferences', 'melonDS'));
  else if (platform === 'win32') dirs.push(...[env.LOCALAPPDATA, env.APPDATA].filter(Boolean).map((d) => P.join(d, 'melonDS')));
  else dirs.push(P.join(env.XDG_CONFIG_HOME || P.join(home, '.config'), 'melonDS'), P.join(home, '.var', 'app', 'net.kuribo64.melonDS', 'config', 'melonDS'));
  return dirs.flatMap((d) => ['melonDS.toml', 'melonDS.ini'].map((f) => P.join(d, f)));
}

/**
 * The save folders set in melonDS's own settings (Emu settings › Paths › Save files – `SaveFilePath`, per instance in
 * 1.x) – empty means "next to the ROM", melonDS's default. A relative folder counts from melonDS's config folder.
 * `files`: melonConfigFiles(). → absolute folders, the first instance's first; [] when none is set.
 */
export function melonSaveDirs(files = melonConfigFiles()) {
  const out = [];
  for (const f of files) {
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    // TOML: SaveFilePath = "C:\\Saves" (backslashes escaped) or 'C:\Saves'; INI: SaveFilePath=C:\Saves
    for (const m of text.matchAll(/^[ \t]*SaveFilePath[ \t]*=[ \t]*(?:"((?:[^"\\\r\n]|\\.)*)"|'([^'\r\n]*)'|([^\r\n]*?))[ \t]*$/gm)) {
      const raw = m[1] !== undefined ? m[1].replace(/\\(["\\])/g, '$1') : m[2] ?? m[3] ?? '';
      const v = raw.trim();
      if (!v) continue;
      const abs = isAbsolute(v) || /^[A-Za-z]:[\\/]/.test(v) ? v : resolve(dirname(f), v);
      if (!out.includes(abs)) out.push(abs);
    }
    break; // the first config there is, is the one melonDS uses
  }
  return out;
}

export function detectEmulator(id, customPath) {
  const emu = EMULATORS[id];
  if (!emu) return { installed: false };
  const candidates = [];
  const custom = customPath ? validCustomPath(id, customPath) : null;
  if (custom) candidates.push({ path: custom, source: 'custom' });
  const local = findIn(dirFor(id), (n) => (process.platform === 'darwin' ? emu.app.test(n) : emu.exe.test(n)));
  if (local) candidates.push({ path: local, source: 'app' });
  // legacy location from earlier versions
  if (id === 'melonds') {
    const legacy = findIn(join(TOOLS_DIR, 'emulator'), (n) => emu.app.test(n) || emu.exe.test(n));
    if (legacy) candidates.push({ path: legacy, source: 'app' });
  }
  if (process.platform === 'darwin') {
    const appName = { mgba: 'mGBA.app', melonds: 'melonDS.app', azahar: 'Azahar.app' }[id];
    candidates.push({ path: `/Applications/${appName}`, source: 'system' }, { path: join(process.env.HOME || '', 'Applications', appName), source: 'system' });
  }
  if (process.platform === 'win32') {
    for (const path of windowsSystemPaths(id)) candidates.push({ path, source: 'system' });
  }
  if (process.platform === 'linux') {
    for (const path of linuxSystemPaths(id)) candidates.push({ path, source: 'system' });
  }
  const found = candidates.find((c) => existsSync(c.path));
  return found ? { installed: true, ...found } : { installed: false };
}

/**
 * Download and install the latest release of an emulator into twincable's tools folder. Every failure is an httpError
 * with a code (web/lib/errors.mjs shows it in the player's language) – the English text is only the fallback.
 */
export async function installEmulator(id, { fetchImpl = fetch } = {}) {
  const emu = EMULATORS[id];
  if (!emu) throw httpError(404, 'Unknown emulator', 'unknownEmulator');
  const vars = { emu: emu.name };
  const offline = (e) => httpError(502, `GitHub can’t be reached: ${e.message}`, 'emuOffline', { ...vars, detail: String(e.cause?.code || e.message).slice(0, 200) });
  let rel;
  try {
    const relRes = await fetchImpl(`https://api.github.com/repos/${emu.repo}/releases/latest`, { headers: { 'User-Agent': 'twincable' } });
    if (!relRes.ok) throw httpError(502, `GitHub answered ${relRes.status} – try again later`, 'emuGithub', { ...vars, status: relRes.status });
    rel = await relRes.json();
  } catch (e) {
    throw e.status ? e : offline(e);
  }
  const asset = pickAsset(rel.assets, id);
  if (!asset) throw httpError(404, `No ${emu.name} download for ${process.platform}`, 'emuNoAsset', { ...vars, platform: PLATFORM_NAMES[process.platform] || process.platform });
  let bytes;
  try {
    const res = await fetchImpl(asset.browser_download_url);
    if (!res.ok) throw httpError(502, `Download failed (${res.status})`, 'emuDownload', { ...vars, detail: `HTTP ${res.status}` });
    bytes = Buffer.from(await res.arrayBuffer()); // download fully before touching a working install
  } catch (e) {
    throw e.status ? e : httpError(502, `Download failed: ${e.message}`, 'emuDownload', { ...vars, detail: String(e.cause?.code || e.message).slice(0, 200) });
  }
  await installDownloaded(id, asset.name, bytes, dirFor(id));
  return { ...detectEmulator(id), version: rel.tag_name };
}

/** Readable platform names for messages. */
const PLATFORM_NAMES = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

/** Remove a folder, true when it is gone (a file in it may be in use – Windows – or the folder may not exist). */
function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // in use – reported by the caller where it matters
  }
  return !existsSync(dir);
}

/**
 * Unpack a downloaded release (`name`, `bytes`) as the emulator's folder `dir`. Unpacked next to it first
 * (`<dir>.new`) and only swapped in once the emulator is found inside: a failed or interrupted install never leaves
 * a half-unpacked emulator behind or destroys the working one, and the next try starts clean – a leftover `.new`
 * (or a file where a folder must go) from an earlier attempt is removed first.
 */
export async function installDownloaded(id, name, bytes, dir, { platform = process.platform } = {}) {
  const emu = EMULATORS[id];
  const vars = { emu: emu.name };
  const stage = `${dir}.new`;
  const old = `${dir}.old`;
  removeDir(old); // a swap that was cut short
  if (!removeDir(stage)) throw httpError(409, `The old download of ${emu.name} can’t be removed: ${stage}`, 'emuInUse', vars);
  const unpackError = (detail) => httpError(500, `Unpacking failed: ${detail}`, 'emuUnpack', { ...vars, detail: String(detail).slice(0, 300) });
  const file = join(stage, safeFileName(name));
  try {
    mkdirSync(stage, { recursive: true });
    writeFileSync(file, bytes);
  } catch (e) {
    removeDir(stage);
    throw httpError(500, `The download couldn’t be saved: ${e.message}`, 'emuWrite', { ...vars, detail: e.code || e.message });
  }
  let ok = true;
  if (platform !== 'darwin' && /\.(zip|7z)$/i.test(name)) {
    // Windows / Linux: unpacked in JavaScript – no PowerShell quoting, and Windows 10's tar.exe can't read 7z (LZMA)
    try {
      await extractArchiveAsync(file, stage); // on a worker thread: the app's window stays responsive
    } catch (e) {
      removeDir(stage);
      throw unpackError(e.message);
    }
  } else if (name.endsWith('.dmg')) {
    const mount = join(stage, 'mnt');
    mkdirSync(mount, { recursive: true });
    ok = spawnSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, file]).status === 0;
    if (ok) {
      const app = findIn(mount, (n) => emu.app.test(n), 1);
      if (app) cpSync(app, join(stage, basename(app)), { recursive: true, verbatimSymlinks: true });
      spawnSync('hdiutil', ['detach', mount, '-force']);
      rmSync(mount, { recursive: true, force: true });
      ok = !!app;
    }
  } else if (name.endsWith('.zip')) {
    ok = spawnSync('ditto', ['-x', '-k', file, stage]).status === 0; // macOS: keeps the .app bundle intact
  } else if (/appimage$/i.test(name)) {
    chmodSync(file, 0o755);
  }
  if (!ok) {
    removeDir(stage);
    throw unpackError(name);
  }
  if (!/appimage$/i.test(name)) rmSync(file, { force: true });
  const inner = findIn(stage, (n) => /\.AppImage$/i.test(n));
  if (inner) chmodSync(inner, 0o755);
  // the emulator must really be in there before the working install is replaced
  if (!findIn(stage, (n) => (platform === 'darwin' ? emu.app.test(n) : emu.exe.test(n)))) {
    removeDir(stage);
    throw unpackError(`${emu.name} not found in ${name}`);
  }
  // swap: the old folder is moved aside first – on Windows that fails as a whole while the emulator runs (its files
  // are in use), instead of deleting half of it
  if (existsSync(dir)) {
    try {
      renameRetry(dir, old);
    } catch {
      removeDir(stage);
      throw httpError(409, `${emu.name} is still running – close it and try again`, 'emuInUse', vars);
    }
  }
  try {
    renameRetry(stage, dir);
  } catch (e) {
    if (existsSync(old) && !existsSync(dir)) renameRetry(old, dir); // put the working one back
    removeDir(stage);
    throw httpError(500, `Installing failed: ${e.message}`, 'emuWrite', { ...vars, detail: e.code || e.message });
  }
  removeDir(old);
  if (platform === 'darwin') {
    const app = findIn(dir, (n) => emu.app.test(n));
    if (app) spawnSync('xattr', ['-dr', 'com.apple.quarantine', app]);
  }
}

/** Resolves once the process has started; rejects if it can't be spawned (e.g. not executable). */
export async function launchRom(id, romPath, { customPath, script } = {}) {
  const emu = detectEmulator(id, customPath);
  if (!emu.installed) throw httpError(404, `${EMULATORS[id]?.name || id} isn’t installed`, 'emuNotInstalled', { emu: EMULATORS[id]?.name || id });
  // A .cia isn't started from the file – Azahar installs it (File › Install CIA) and lists the game; open it empty.
  const args = romPath && !(id === 'azahar' && /\.z?cia$/i.test(romPath)) ? [romPath] : [];
  let child;
  const exeName = basename(emu.path.replace(/[\\/]+$/, ''));
  if (id === 'azahar') {
    // One Azahar at a time: a second one would find its RPC port taken (no live data), and on macOS `open -a` only
    // brings an open Azahar to the front without handing it the game.
    if (emulatorRunning(/(?:^|[\\/"])azahar(?:\.exe)?(?:"|$)/im)) throw httpError(409, 'Azahar is already open – start the game there, or close Azahar first', 'emulatorOpen', { emu: 'Azahar' });
  }
  if (process.platform === 'darwin' && /\.app$/i.test(exeName)) {
    if (!EMULATORS[id].app.test(exeName)) throw httpError(400, 'Invalid emulator path', 'badEmulatorPath');
    child = spawn('open', ['-a', emu.path, '--args', ...args], { detached: true, stdio: 'ignore' });
  } else {
    if (!EMULATORS[id].exe.test(exeName)) throw httpError(400, 'Invalid emulator path', 'badEmulatorPath');
    // Windows: started from its own folder, so mGBA's portable.ini (settings next to the exe) and its DLLs are found
    child = spawn(emu.path, args, { detached: true, stdio: 'ignore', ...(process.platform === 'win32' ? { cwd: dirname(emu.path) } : {}) });
  }
  // An unhandled 'error' event on the child would crash the whole server.
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (e) => reject(httpError(500, `${EMULATORS[id]?.name || id} couldn’t be started: ${e.message}`, 'emuLaunch', { emu: EMULATORS[id]?.name || id, detail: e.code || e.message })));
  });
  child.unref();
  return { ...emu, script };
}

/**
 * The command that shows `path` selected in the file manager (Finder / Explorer), as [command, args, options].
 * Linux has no common "select this file" command: xdg-open opens the folder (a file's own folder – xdg-open on the
 * file itself would open it, e.g. start an emulator with a ROM).
 */
export function revealCommand(path, platform = process.platform, { isDir = false } = {}) {
  if (platform === 'darwin') return ['open', ['-R', path], {}];
  // Explorer parses its own command line: /select,"C:\path with spaces\file" – passed verbatim, quoted by hand
  // (Windows paths can't contain quotes).
  if (platform === 'win32') return ['explorer.exe', [`/select,"${path.replace(/"/g, '')}"`], { windowsVerbatimArguments: true }];
  return ['xdg-open', [isDir ? path : posix.dirname(path)], {}];
}

export function revealInFileManager(path) {
  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    // gone meanwhile – its folder is still worth showing
  }
  const [cmd, args, opts] = revealCommand(path, process.platform, { isDir });
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts });
  child.on('error', (e) => console.warn('reveal failed:', e.message));
  child.unref();
}

/**
 * Is an external emulator process running? (It would overwrite edits to the .sav.) `names`: which program names
 * count (default: every emulator twincable knows).
 */
export function emulatorRunning(names = /melonDS|NooDS|DeSmuME|desmume|mGBA|azahar/i) {
  try {
    if (process.platform === 'win32') {
      return names.test(spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout || '');
    }
    // every process's command name (procps on Linux spells "all processes" -e, BSD / macOS ps -ax)
    const out = spawnSync('ps', process.platform === 'linux' ? ['-eo', 'comm='] : ['-axo', 'comm='], { encoding: 'utf8' }).stdout || '';
    return out.split('\n').some((line) => names.test(line.split('/').pop()));
  } catch {
    return false;
  }
}

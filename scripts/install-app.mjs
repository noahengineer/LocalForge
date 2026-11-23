#!/usr/bin/env node
// Install the packaged AppImage for the current user (no sudo):
//   ~/Applications/LocalForge.AppImage
//   ~/.local/share/applications/dev.localforge.LocalForge.desktop   (KDE launcher entry)
//   ~/.local/share/icons/hicolor/<size>/apps/dev.localforge.LocalForge.png
// The .desktop file name equals the app's Wayland app_id (package.json "desktopName"), so KDE
// shows the right icon in the task manager. `--uninstall` removes all of it.
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, renameSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const appId = pkg.build.appId // dev.localforge.LocalForge
const home = os.homedir()
const appDir = path.join(home, 'Applications')
const target = path.join(appDir, 'LocalForge.AppImage')
const desktopDir = path.join(home, '.local', 'share', 'applications')
const desktopFile = path.join(desktopDir, `${appId}.desktop`)
const iconRoot = path.join(home, '.local', 'share', 'icons', 'hicolor')
const sizes = [16, 32, 48, 64, 128, 256, 512]

function tryRun(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

if (process.argv.includes('--uninstall')) {
  rmSync(target, { force: true })
  rmSync(desktopFile, { force: true })
  for (const s of sizes) rmSync(path.join(iconRoot, `${s}x${s}`, 'apps', `${appId}.png`), { force: true })
  rmSync(path.join(iconRoot, 'scalable', 'apps', `${appId}.svg`), { force: true })
  tryRun('update-desktop-database', [desktopDir])
  tryRun('kbuildsycoca6', [])
  console.log('LocalForge uninstalled.')
  process.exit(0)
}

const releaseDir = path.join(root, 'release')
const built = existsSync(releaseDir) ? readdirSync(releaseDir).filter((f) => f.endsWith('.AppImage')).sort() : []
if (built.length === 0) {
  console.error('No AppImage in release/. Run `npm run dist` first.')
  process.exit(1)
}
const src = path.join(releaseDir, built[built.length - 1])

mkdirSync(appDir, { recursive: true })
// Copy then rename: a running LocalForge keeps its (old) file; overwriting in place would break it.
copyFileSync(src, `${target}.new`)
chmodSync(`${target}.new`, 0o755)
renameSync(`${target}.new`, target)
chmodSync(target, 0o755)

for (const s of sizes) {
  const dir = path.join(iconRoot, `${s}x${s}`, 'apps')
  mkdirSync(dir, { recursive: true })
  copyFileSync(path.join(root, 'build', 'icons', `${s}x${s}.png`), path.join(dir, `${appId}.png`))
}
mkdirSync(path.join(iconRoot, 'scalable', 'apps'), { recursive: true })
copyFileSync(path.join(root, 'build', 'icon.svg'), path.join(iconRoot, 'scalable', 'apps', `${appId}.svg`))

mkdirSync(desktopDir, { recursive: true })
writeFileSync(
  desktopFile,
  `[Desktop Entry]
Type=Application
Name=LocalForge
GenericName=AI Coding Workspace
Comment=${pkg.build.linux.synopsis}
Exec=env APPIMAGELAUNCHER_DISABLE=1 ${target} %U
TryExec=${target}
Icon=${appId}
Terminal=false
Categories=Development;IDE;
Keywords=AI;LLM;agent;coding;llama;sandbox;
StartupNotify=true
StartupWMClass=${appId}
`,
)
chmodSync(desktopFile, 0o755)

tryRun('update-desktop-database', [desktopDir])
tryRun('gtk-update-icon-cache', ['-f', '-t', iconRoot])
tryRun('kbuildsycoca6', [])

console.log(`Installed ${path.basename(src)}
  app:     ${target}
  launcher: ${desktopFile}
  icons:   ${iconRoot}/*/apps/${appId}.png`)

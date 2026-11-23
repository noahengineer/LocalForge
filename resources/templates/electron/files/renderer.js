const info = document.getElementById('info')
info.textContent = `Electron ${window.versions.electron()} · Chromium ${window.versions.chrome()} · Node ${window.versions.node()}`

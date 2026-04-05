const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') {
  process.exit(0);
}

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const cacheDir = path.join(localAppData, 'electron-builder', 'Cache', 'winCodeSign');
const archiveUrl = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z';
const archivePath = path.join(cacheDir, 'winCodeSign-2.6.0.7z');
const sevenZipPath = path.join(__dirname, '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
const requiredFiles = [
  'rcedit-x64.exe',
  'rcedit-ia32.exe',
  path.join('windows-10', 'x64', 'signtool.exe')
];

function hasRequiredFiles(dirPath) {
  return requiredFiles.every((file) => fs.existsSync(path.join(dirPath, file)));
}

function copyRecursiveSync(sourcePath, destinationPath) {
  const stats = fs.statSync(sourcePath);

  if (stats.isDirectory()) {
    fs.mkdirSync(destinationPath, { recursive: true });
    for (const entry of fs.readdirSync(sourcePath)) {
      copyRecursiveSync(path.join(sourcePath, entry), path.join(destinationPath, entry));
    }
    return;
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        downloadFile(response.headers.location, destination).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`No se pudo descargar winCodeSign (${response.statusCode}).`));
        return;
      }

      const fileStream = fs.createWriteStream(destination);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(resolve);
      });

      fileStream.on('error', (error) => {
        fileStream.close(() => reject(error));
      });
    });

    request.on('error', reject);
  });
}

async function prepareWinCodeSign() {
  fs.mkdirSync(cacheDir, { recursive: true });

  if (hasRequiredFiles(cacheDir)) {
    console.log('[prepare-win-codesign] Caché lista.');
    return;
  }

  let sourceDir = fs
    .readdirSync(cacheDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(cacheDir, entry.name))
    .find((dirPath) => hasRequiredFiles(dirPath));

  if (!sourceDir) {
    if (!fs.existsSync(archivePath)) {
      console.log('[prepare-win-codesign] Descargando winCodeSign...');
      await downloadFile(archiveUrl, archivePath);
    }

    const tempDir = path.join(cacheDir, 'manual-extract');
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.mkdirSync(tempDir, { recursive: true });

    const result = spawnSync(sevenZipPath, ['x', '-snld', '-bd', archivePath, `-o${tempDir}`], {
      encoding: 'utf8'
    });

    if (result.status !== 0 && !hasRequiredFiles(tempDir)) {
      throw new Error(result.stderr || result.stdout || `7za terminó con código ${result.status}.`);
    }

    sourceDir = tempDir;
  }

  for (const entry of fs.readdirSync(sourceDir)) {
    copyRecursiveSync(path.join(sourceDir, entry), path.join(cacheDir, entry));
  }

  if (!hasRequiredFiles(cacheDir)) {
    throw new Error('No se pudieron preparar las herramientas de winCodeSign.');
  }

  console.log('[prepare-win-codesign] Herramientas listas.');
}

prepareWinCodeSign().catch((error) => {
  console.error('[prepare-win-codesign]', error.message);
  process.exit(1);
});

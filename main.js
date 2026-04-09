const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const { launch, MinecraftFolder } = require('@xmcl/core');
const { installVersion, installForge, installFabric, installQuilt } = require('@xmcl/installer');
const { ModrinthV2Client } = require('@xmcl/modrinth');
const { CurseforgeV1Client } = require('@xmcl/curseforge');
const path = require('path');
const os = require('os');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const nbt = require('prismarine-nbt');
const RPC = require('discord-rpc');
const { getStatus } = require('mc-server-status');

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
    app.quit();
    process.exit(0);
}

app.on('second-instance', () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

// Configuración
const configPath = path.join(__dirname, 'config.json');
let config = {
    minecraftPath: path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft'),
    javaPath: '',
    disableGPU: true
};

// Leer configuración de GPU antes de iniciar
let gpuDisabled = true;
try {
    if (fs.existsSync(configPath)) {
        const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (typeof rawConfig.disableGPU !== 'undefined') {
            gpuDisabled = rawConfig.disableGPU !== false;
        }
    }
} catch (e) {
    console.error('Error cargando config de GPU:', e);
}

if (gpuDisabled) {
    app.disableHardwareAcceleration();
    console.log('Aceleración de GPU desactivada por configuración.');
}

// Instancia global de Minecraft
let mcFolder;

// Función para detectar automáticamente el directorio de Minecraft
function detectMinecraftPath() {
    const possiblePaths = [
        path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft'), // Estándar
        path.join(os.homedir(), 'Documents', '.minecraft'), // En Documents
        path.join(os.homedir(), 'OneDrive', 'Documents', '.minecraft'), // En OneDrive Documents
        path.join(os.homedir(), 'Documents', '111'), // Específico del usuario
    ];

    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            console.log(`Directorio de Minecraft detectado automáticamente: ${p}`);
            return p;
        }
    }

    // Si ninguno existe, usar el estándar (se creará al instalar versiones)
    const defaultPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft');
    console.log(`Usando directorio por defecto: ${defaultPath}`);
    return defaultPath;
}

// Cargar configuración
if (fs.existsSync(configPath)) {
    try {
        config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
        if (!config.minecraftPath || !fs.existsSync(config.minecraftPath)) {
            config.minecraftPath = detectMinecraftPath();
            saveConfig();
        }
    } catch (e) {
        console.error('Error cargando config:', e);
        config.minecraftPath = detectMinecraftPath();
        saveConfig();
    }
} else {
    // Detectar automáticamente y crear config
    config.minecraftPath = detectMinecraftPath();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

mcFolder = new MinecraftFolder(config.minecraftPath);

// Si por alguna razón el directorio no existe, creamos carpeta .minecraft base para evitar fallos
try {
    if (!fs.existsSync(config.minecraftPath)) {
        fs.mkdirSync(config.minecraftPath, { recursive: true });
        console.log('Se creó la carpeta .minecraft en:', config.minecraftPath);
    }
} catch (e) {
    console.error('No se pudo crear la carpeta .minecraft:', e);
}

function saveConfig() {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function ensureDirectoryExists(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function copyCustomLibrariesIntoMinecraft() {
    const customLibrariesRoot = path.join(__dirname, 'resources', 'libs');
    if (!fs.existsSync(customLibrariesRoot)) {
        console.log('[Azure] No se encontró carpeta de librerías personalizadas en resources/libs.');
        return [];
    }

    const copiedFiles = [];

    function walkDirectory(currentDir) {
        for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
            const entryPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                walkDirectory(entryPath);
                continue;
            }

            if (!entry.isFile()) continue;

            const relativePath = path.relative(customLibrariesRoot, entryPath);
            const destinationPath = path.join(getRootPath(), 'libraries', relativePath);

            if (!fs.existsSync(destinationPath)) {
                ensureDirectoryExists(path.dirname(destinationPath));
                fs.copyFileSync(entryPath, destinationPath);
                copiedFiles.push(destinationPath);
                console.log(`[Azure] Copiada librería personalizada: ${relativePath}`);
            }
        }
    }

    walkDirectory(customLibrariesRoot);
    return copiedFiles;
}

// ===== FUNCIONES PARA MANEJAR LIBRERÍAS FALTANTES =====

// Verificar si una librería existe localmente
function checkLibraryExists(lib) {
    const libPath = path.join(getRootPath(), 'libraries', lib.path);
    return fs.existsSync(libPath);
}

// Intentar descargar una librería faltante
async function downloadMissingLibrary(lib, event) {
    if (!lib.download || !lib.download.url) {
        console.warn(`[XMCL] No hay URL de descarga para ${lib.name}`);
        return false;
    }

    const libPath = path.join(getRootPath(), 'libraries', lib.path);

    try {
        await downloadMissingLibrary(lib.download.url, libPath);
        console.log(`[XMCL] Descargada librería: ${lib.name}`);
        return true;
    } catch (error) {
        console.error(`[XMCL] Error descargando ${lib.name}:`, error.message);
        return false;
    }
}

// Verificar y descargar librerías faltantes antes del lanzamiento
async function ensureLibraries(version, event) {
    try {
        // Obtener información de la versión
        const versionPath = path.join(getRootPath(), 'versions', version, `${version}.json`);
        if (!fs.existsSync(versionPath)) {
            return true; // Si no hay archivo de versión, asumir que está bien
        }

        const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
        const missingLibs = [];

        // Verificar cada librería
        for (const lib of versionData.libraries || []) {
            if (lib.downloads && lib.downloads.artifact) {
                if (!checkLibraryExists(lib.downloads.artifact)) {
                    missingLibs.push(lib.downloads.artifact);
                }
            }
        }

        // Intentar descargar librerías faltantes
        for (const lib of missingLibs) {
            const success = await downloadMissingLibrary(lib, event);
            if (!success) {
                console.warn(`[XMCL] No se pudo descargar ${lib.name}`);
            }
        }

        return true;
    } catch (error) {
        console.error('[XMCL] Error verificando librerías:', error);
        return false;
    }
}

// Detectar versiones locales instaladas
function getLocalVersions() {
    try {
        const versionsDir = path.join(mcFolder.root, 'versions');
        if (!fs.existsSync(versionsDir)) return [];

        return fs.readdirSync(versionsDir)
            .filter(v => fs.existsSync(path.join(versionsDir, v, v + '.json')))
            .map(v => ({
                id: v,
                type: 'local',
                path: path.join(versionsDir, v),
                displayName: v
            }))
            .sort((a, b) => {
                const aNum = parseFloat(a.id.replace(/[^\d.]/g, ''));
                const bNum = parseFloat(b.id.replace(/[^\d.]/g, ''));
                return bNum - aNum;
            });
    } catch (error) {
        console.error('[XMCL] Error detectando versiones locales:', error);
        return [];
    }
}

// Detectar instancias CurseForge
function getCurseforgeInstances() {
    try {
        const curseforgePath = path.join(os.homedir(), 'curseforge', 'minecraft', 'Instances');
        if (!fs.existsSync(curseforgePath)) return [];

        return fs.readdirSync(curseforgePath)
            .filter(dir => {
                const instancePath = path.join(curseforgePath, dir);
                return fs.existsSync(path.join(instancePath, 'minecraftinstance.json'));
            })
            .map(dir => {
                const instancePath = path.join(curseforgePath, dir);
                try {
                    const manifest = JSON.parse(fs.readFileSync(path.join(instancePath, 'minecraftinstance.json'), 'utf8'));
                    return {
                        id: `curseforge-${dir}`,
                        type: 'curseforge',
                        path: instancePath,
                        displayName: manifest.name || dir,
                        version: manifest.gameVersion,
                        loader: manifest.baseModLoader?.name?.toLowerCase() || 'vanilla',
                        mods: manifest.installedModpack?.mods?.length || 0
                    };
                } catch (error) {
                    return {
                        id: `curseforge-${dir}`,
                        type: 'curseforge',
                        path: instancePath,
                        displayName: dir,
                        version: 'unknown',
                        loader: 'unknown'
                    };
                }
            });
    } catch (error) {
        console.error('[XMCL] Error detectando CurseForge:', error);
        return [];
    }
}

// Detectar perfiles Modrinth
function getModrinthProfiles() {
    try {
        const modrinthPath = path.join(os.homedir(), 'AppData', 'Roaming', 'ModrinthApp', 'profiles');
        if (!fs.existsSync(modrinthPath)) return [];

        return fs.readdirSync(modrinthPath)
            .filter(dir => {
                const profilePath = path.join(modrinthPath, dir);
                return fs.existsSync(path.join(profilePath, 'profile.json'));
            })
            .map(dir => {
                const profilePath = path.join(modrinthPath, dir);
                try {
                    const profile = JSON.parse(fs.readFileSync(path.join(profilePath, 'profile.json'), 'utf8'));
                    return {
                        id: `modrinth-${dir}`,
                        type: 'modrinth',
                        path: profilePath,
                        displayName: profile.metadata?.name || dir,
                        version: profile.metadata?.game_version,
                        loader: profile.metadata?.loader || 'vanilla',
                        mods: profile.metadata?.mods?.length || 0
                    };
                } catch (error) {
                    return {
                        id: `modrinth-${dir}`,
                        type: 'modrinth',
                        path: profilePath,
                        displayName: dir,
                        version: 'unknown',
                        loader: 'unknown'
                    };
                }
            });
    } catch (error) {
        console.error('[XMCL] Error detectando Modrinth:', error);
        return [];
    }
}

// Detectar instancias PrismLauncher
function getPrismLauncherInstances() {
    try {
        const prismPath = path.join(os.homedir(), 'AppData', 'Roaming', 'PrismLauncher', 'instances');
        if (!fs.existsSync(prismPath)) return [];

        return fs.readdirSync(prismPath)
            .filter(dir => {
                const instancePath = path.join(prismPath, dir);
                return fs.existsSync(path.join(instancePath, 'instance.cfg'));
            })
            .map(dir => {
                const instancePath = path.join(prismPath, dir);
                try {
                    const cfgPath = path.join(instancePath, 'instance.cfg');
                    const cfg = fs.readFileSync(cfgPath, 'utf8');
                    const config = {};
                    cfg.split('\n').forEach(line => {
                        const [key, ...value] = line.split('=');
                        if (key && value) config[key.trim()] = value.join('=').trim();
                    });

                    return {
                        id: `prismlaucher-${dir}`,
                        type: 'prismlaucher',
                        path: instancePath,
                        displayName: config.name || dir,
                        version: config.IntendedVersion || 'unknown',
                        loader: 'auto' // PrismLauncher maneja loaders automáticamente
                    };
                } catch (error) {
                    return {
                        id: `prismlaucher-${dir}`,
                        type: 'prismlaucher',
                        path: instancePath,
                        displayName: dir,
                        version: 'unknown',
                        loader: 'unknown'
                    };
                }
            });
    } catch (error) {
        console.error('[XMCL] Error detectando PrismLauncher:', error);
        return [];
    }
}

// Obtener todas las instalaciones disponibles
function getAllInstallations() {
    const installations = [
        ...getLocalVersions(),
        ...getCurseforgeInstances(),
        ...getModrinthProfiles(),
        ...getPrismLauncherInstances()
    ];

    return installations;
}

// Detectar Java automáticamente
function detectJavaVersion() {
    if (config.javaPath && fs.existsSync(config.javaPath)) {
        console.log(`Java detectado desde configuración: ${config.javaPath}`);
        return config.javaPath;
    }

    const possibleJavas = [
        'C:\\Program Files\\Java\\jdk-21\\bin\\javaw.exe',
        'C:\\Program Files\\Java\\jdk-17\\bin\\javaw.exe',
        'C:\\Program Files\\Java\\jdk-11\\bin\\javaw.exe',
        'C:\\Program Files\\Java\\jdk-8\\bin\\javaw.exe',
        'javaw.exe'
    ];

    for (const javaPath of possibleJavas) {
        if (fs.existsSync(javaPath)) {
            console.log(`Java detectado automáticamente: ${javaPath}`);
            return javaPath;
        }
    }

    return 'javaw.exe';
}

function isVersionComplete(versionData) {
    const missingLibs = [];

    for (const lib of versionData.libraries) {
        if (lib.downloads && lib.downloads.artifact) {
            const libPath = path.join(rootPath, 'libraries', lib.downloads.artifact.path);
            if (!fs.existsSync(libPath)) {
                missingLibs.push(lib.name || lib.downloads.artifact.path);
            }
        } else if (lib.name) {
            const parts = lib.name.split(':');
            if (parts.length >= 3) {
                const [group, name, version] = parts;
                const groupPath = group.replace(/\./g, '/');
                const jarName = `${name}-${version}.jar`;
                const libPath = path.join(getRootPath(), 'libraries', groupPath, name, version, jarName);
                if (!fs.existsSync(libPath)) {
                    missingLibs.push(lib.name);
                }
            }
        }
    }

    const jarPath = path.join(getRootPath(), 'versions', versionData.id, versionData.id + '.jar');
    if (!fs.existsSync(jarPath)) {
        missingLibs.push(`JAR principal: ${versionData.id}.jar`);
    }

    return { complete: missingLibs.length === 0, missingLibs };
}

function buildClasspath(versionData) {
    const libs = [];

    for (const lib of versionData.libraries) {
        // Manejar librerías con estructura estándar (downloads.artifact)
        if (lib.downloads && lib.downloads.artifact) {
            const libPath = path.join(getRootPath(), 'libraries', lib.downloads.artifact.path);
            if (fs.existsSync(libPath)) {
                libs.push(libPath);
            } else {
                console.warn(`[Azure] Librería faltante: ${lib.name} en ${libPath}`);
            }
        }
        // Manejar librerías con estructura alternativa (algunas versiones de Forge)
        else if (lib.name) {
            // Convertir nombre de librería a path (group:name:version -> group/name/version/name-version.jar)
            const parts = lib.name.split(':');
            if (parts.length >= 3) {
                const [group, name, version] = parts;
                const groupPath = group.replace(/\./g, '/');
                const jarName = `${name}-${version}.jar`;
                const libPath = path.join(getRootPath(), 'libraries', groupPath, name, version, jarName);

                if (fs.existsSync(libPath)) {
                    libs.push(libPath);
                } else {
                    console.warn(`[Azure] Librería faltante (alt): ${lib.name} en ${libPath}`);
                }
            }
        }
    }

    const jarPath = path.join(getRootPath(), 'versions', versionData.id, versionData.id + '.jar');
    if (!fs.existsSync(jarPath)) {
        console.warn(`[Azure] JAR de versión faltante: ${jarPath}`);
    }

    return [...libs, jarPath].join(';');
}

function buildLaunchArgs(versionData, username, ram) {
    const classpath = buildClasspath(versionData);
    const javaPath = detectJavaVersion();

    const baseArgs = [
        `-Xmx${ram}G`,
        '-Xms512M',

        // Flags JVM necesarios para Forge/NeoForge/Fabric/OptiFine con Java 17+
        '--add-opens=java.base/java.lang=ALL-UNNAMED',
        '--add-opens=java.base/java.util=ALL-UNNAMED',
        '--add-opens=java.base/java.lang.invoke=ALL-UNNAMED',
        '--add-opens=java.base/java.nio=ALL-UNNAMED',
        '--add-opens=java.base/java.util.jar=ALL-UNNAMED',
        '--add-opens=java.base/java.util.zip=ALL-UNNAMED',

        // Propiedades del sistema para mayor compatibilidad con Forge
        '-Dfml.ignoreInvalidMinecraftCertificates=true',
        '-Dfml.ignorePatchDiscrepancies=true',

        '-cp',
        classpath,
        versionData.mainClass,
        '--username',
        username || 'Player',
        '--version',
        versionData.id,
        '--gameDir',
        getRootPath(),
        '--assetsDir',
        path.join(getRootPath(), 'assets'),
        '--assetIndex',
        versionData.assets || versionData.id,
        '--uuid',
        'offline-player-uuid',
        '--accessToken',
        'offline',
        '--userType',
        'mojang'
    ];

    // Agregar argumentos específicos del loader
    if (versionData.arguments && versionData.arguments.game) {
        baseArgs.push(...versionData.arguments.game);
    }

    return { javaPath, args: baseArgs };
}

function isOptifineVersion(selectedVersion, versionJsonPath) {
    if (/optifine/i.test(selectedVersion)) {
        return true;
    }

    if (!fs.existsSync(versionJsonPath)) {
        return false;
    }

    try {
        const parsedJson = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
        const libraries = parsedJson?.libraries;
        if (Array.isArray(libraries)) {
            return libraries.some((lib) => /optifine|launchwrapper-of/i.test(JSON.stringify(lib)));
        }
    } catch (error) {
        console.warn('[Azure] Error parseando JSON de versión para detectar OptiFine:', error?.message || error);
    }

    return false;
}

function downloadMissingLibrary(url, dest) {
    return new Promise((resolve, reject) => {
        ensureDirectoryExists(path.dirname(dest));

        const fileStream = fs.createWriteStream(dest);
        const request = https.get(url, (response) => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                const redirectUrl = response.headers.location;
                fileStream.close();
                fs.unlink(dest, () => {
                    if (!redirectUrl) {
                        reject(new Error(`Redirección sin ubicación desde ${url}`));
                        return;
                    }
                    downloadMissingLibrary(redirectUrl, dest).then(resolve).catch(reject);
                });
                return;
            }

            if (response.statusCode !== 200) {
                fileStream.close();
                fs.unlink(dest, () => reject(new Error(`Respuesta HTTP ${response.statusCode} al descargar ${url}`)));
                return;
            }

            response.pipe(fileStream);
            fileStream.on('finish', () => fileStream.close(resolve));
        });

        request.on('error', (error) => {
            fileStream.close();
            fs.unlink(dest, () => reject(error));
        });
    });
}

async function ensureOptifineLaunchwrapper(event, selectedVersion, versionJsonPath) {
    if (!isOptifineVersion(selectedVersion, versionJsonPath)) {
        return;
    }

    const launchwrapperDir = path.join(getRootPath(), 'libraries', 'optifine', 'launchwrapper-of', '2.3');
    const launchwrapperFile = path.join(launchwrapperDir, 'launchwrapper-of-2.3.jar');

    if (fs.existsSync(launchwrapperFile)) {
        return;
    }

    const mirrorUrl = process.env.AZURE_OPTIFINE_LAUNCHWRAPPER_URL;
    if (!mirrorUrl) {
        console.warn('[Azure] launchwrapper-of faltante y no hay mirror configurado. Se asume instalación oficial de OptiFine o librerías ya presentes.');
        return;
    }

    event.reply('status', 'Descargando dependencias necesarias de OptiFine...');
    console.log(`[Azure] launchwrapper-of no encontrado. Intentando descargar desde ${mirrorUrl}`);

    try {
        await downloadMissingLibrary(mirrorUrl, launchwrapperFile);
        console.log('[Azure] launchwrapper-of descargado correctamente.');
    } catch (error) {
        const message = `No se pudo descargar launchwrapper-of de OptiFine: ${error?.message || error}`;
        console.error('[Azure] ' + message);
        event.reply('status', message);
        throw new Error(message);
    }
}

// Función para obtener rootPath
function getRootPath() {
    return config.minecraftPath;
}

let mainWindow;
let gameLogInterval = null;
let lastLaunchUsername = 'Jugador';
let currentVersion = '';
let isLaunching = false;
let launchSessionFinished = false;

function limpiarNombreVersion(version) {
    if (!version || typeof version !== 'string') return '';
    return version.replace(/HD|Ultra|Standard|L7|I7|G5|F5/gi, '').replace(/\s+/g, ' ').trim();
}

function formatearDetallesVersion(version) {
    const v = limpiarNombreVersion(version);
    if (/optifine/i.test(version)) {
        return `No se Optifine (${v})`;
    }
    return `Minecraft ${v}`;
}

function verificarVersionJava(javaPath) {
    return new Promise((resolve) => {
        const comando = `"${javaPath}" -version`;
        exec(comando, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error ejecutando ${comando}:`, error.message);
                resolve(null);
                return;
            }

            const output = stderr || stdout;
            const match = output.match(/version "(\d+)\.(\d+)\.(\d+)"/);
            if (match) {
                const major = parseInt(match[1]);
                const minor = parseInt(match[2]);
                console.log(`Java detectado: ${major}.${minor}.${match[3]} en ${javaPath}`);
                resolve({ major, minor, full: `${major}.${minor}.${match[3]}` });
            } else {
                console.warn(`No se pudo parsear versión de Java: ${output}`);
                resolve(null);
            }
        });
    });
}

function limpiarCacheMinecraft(version = null) {
    const root = getRootPath(); // Usar rootPath consistente
    const librariesPath = path.join(root, 'libraries');
    const versionsPath = path.join(root, 'versions');
    const assetsIndexesPath = path.join(root, 'assets', 'indexes');

    try {
        if (fs.existsSync(librariesPath)) {
            console.log('Limpiando libraries...');
            fs.rmSync(librariesPath, { recursive: true, force: true });
        }

        if (fs.existsSync(assetsIndexesPath)) {
            console.log('Limpiando índices de assets...');
            fs.rmSync(assetsIndexesPath, { recursive: true, force: true });
        }

        if (version && fs.existsSync(path.join(versionsPath, version))) {
            console.log(`Limpiando versión ${version}...`);
            fs.rmSync(path.join(versionsPath, version), { recursive: true, force: true });
        }

        console.log('Cache limpiado exitosamente.');
        return true;
    } catch (error) {
        console.error('Error limpiando cache:', error);
        return false;
    }
}

// variables globales para la presencia claramente controladas
let currentLaunchVars = { username: 'Jugador', version: '' };

function updateMinecraftPresence(status, ip = null) {
    if (!rpcReady || !rpcClient) return;

    const versionTexto = formatearDetallesVersion(currentLaunchVars.version || 'Desconocida');
    const estadoActual = ip ? `Multiplayer: ${ip}` : 'Menu';

    setDiscordActivity({
        details: `Jugando a ${versionTexto}`,
        state: estadoActual,
        largeImageKey: 'azure_logo',
        largeImageText: `Usuario: ${currentLaunchVars.username || 'Jugador'}`
    });
}

let rpcClient = null;
let rpcReady = false;
let discordAuthServer = null;
const rpcStartTime = Date.now();
const DISCORD_CONFIG_PATH = path.join(__dirname, 'discord-oauth.local.json');

let localDiscordConfig = {};
try {
    if (fs.existsSync(DISCORD_CONFIG_PATH)) {
        localDiscordConfig = JSON.parse(fs.readFileSync(DISCORD_CONFIG_PATH, 'utf8'));
    }
} catch (error) {
    console.warn('No se pudo leer discord-oauth.local.json:', error.message);
}

const DISCORD_CLIENT_ID = process.env.AZURE_DISCORD_CLIENT_ID || localDiscordConfig.clientId || '1488321638754943087';
const DISCORD_CLIENT_SECRET = process.env.AZURE_DISCORD_CLIENT_SECRET || localDiscordConfig.clientSecret || '';
const DISCORD_REDIRECT_URI = process.env.AZURE_DISCORD_REDIRECT_URI || localDiscordConfig.redirectUri || 'http://localhost:53134';
const parsedDiscordRedirect = new URL(DISCORD_REDIRECT_URI.includes('://') ? DISCORD_REDIRECT_URI : `http://${DISCORD_REDIRECT_URI}`);
const DISCORD_REDIRECT_PORT = Number(process.env.AZURE_DISCORD_REDIRECT_PORT || localDiscordConfig.redirectPort || parsedDiscordRedirect.port || 53134);
const DISCORD_REDIRECT_PATHS = Array.from(new Set([
    parsedDiscordRedirect.pathname || '/',
    '/',
    '/callback'
]));
const windowsIconPath = path.join(__dirname, 'Azure-Launcher.ico');
const pngIconPath = path.join(__dirname, 'Azure-Launcher.png');
const iconPath = process.platform === 'win32' && fs.existsSync(windowsIconPath)
    ? windowsIconPath
    : pngIconPath;

// Rutas robustas para Windows / macOS / Linux
const appData = process.env.APPDATA || (
    process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : path.join(os.homedir(), '.local', 'share')
);

const rootPath = getRootPath();
const legacyMinecraftPath = path.join(appData, '.minecraft');
const localServersFile = path.join(__dirname, 'servers.dat');
const fallbackServers = [
    { name: 'Azure Network', ip: 'mc.hypixel.net' },
    { name: 'Servidor Eventos', ip: 'play.cubecraft.net' }
];
let autoUpdaterConfigured = false;

function sendToRenderer(channel, payload = {}) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(channel, payload);
}

const MICROSOFT_CLIENT_ID = '00000000402b5328';

async function performMicrosoftLogin() {
    try {
        const { Auth } = require('msmc');
        const authClient = new Auth({
            client_id: MICROSOFT_CLIENT_ID,
            redirect: 'https://login.live.com/oauth20_desktop.srf',
            prompt: 'select_account'
        });

        let serverHandle;
        const loginResult = await new Promise((resolve, reject) => {
            authClient.setServer(async (xbox) => {
                try {
                    const minecraft = await xbox.getMinecraft();
                    resolve({ xbox, minecraft });
                } catch (err) {
                    reject(err);
                }
            }, 0).then((server) => {
                serverHandle = server;
                if (server.link) {
                    shell.openExternal(server.link);
                }
            }).catch(reject);
        });

        if (serverHandle?.server) {
            try {
                serverHandle.server.close();
            } catch (_e) {
                // ignore
            }
        }

        const { minecraft } = loginResult;
        const account = minecraft.getToken(true);

        return {
            profile: minecraft.profile,
            accessToken: minecraft.mcToken,
            refreshToken: account.refresh,
            uuid: minecraft.profile.id,
            username: minecraft.profile.name
        };
    } catch (error) {
        if (error.code === 'MODULE_NOT_FOUND' || String(error).includes('msmc')) {
            throw new Error('Falta la dependencia msmc. Instala con npm install msmc');
        }
        console.error('[Microsoft Login]', error);
        throw error;
    }
}

function createXmclLaunchOptions({ version, gamePath, javaPath, ramSize, auth, finalUsername }) {
    const baseOptions = {
        version,
        gamePath,
        javaPath,
        launcherName: 'Azure Launcher',
        launcherBrand: 'azure-launcher',
        memory: {
            min: '512M',
            max: `${ramSize}G`
        }
    };

    if (auth && auth.accessToken) {
        return {
            ...baseOptions,
            gameProfile: {
                name: auth.name,
                id: auth.uuid || '00000000-0000-0000-0000-000000000000'
            },
            accessToken: auth.accessToken,
            userType: 'msa'
        };
    }

    return {
        ...baseOptions,
        gameProfile: {
            name: finalUsername,
            id: '00000000-0000-0000-0000-000000000000'
        },
        accessToken: 'offline',
        userType: 'legacy'
    };
}

function setLaunchFinished() {
    if (launchSessionFinished) return;
    launchSessionFinished = true;
    sendToRenderer('launch-finished');

    if (mainWindow && !mainWindow.isDestroyed()) {
        setTimeout(() => {
            mainWindow.hide();
            // app.quit(); // descomenta para cerrar el launcher por completo
        }, 700);
    }
}

function setupAutoUpdater() {
    if (autoUpdaterConfigured) return;
    autoUpdaterConfigured = true;

    autoUpdater.logger = null; // Silenciar logs técnicos
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
        sendToRenderer('update-status', {
            state: 'checking',
            message: 'Buscando actualizaciones...'
        });
    });

    autoUpdater.on('update-available', (info) => {
        sendToRenderer('update-status', {
            state: 'available',
            version: info?.version || '',
            message: `Nueva actualización${info?.version ? ` v${info.version}` : ''} encontrada. Descargando...`
        });
    });

    autoUpdater.on('download-progress', (progress) => {
        const percent = Math.max(0, Math.min(100, Math.round(progress?.percent || 0)));
        sendToRenderer('update-status', {
            state: 'downloading',
            percent,
            message: `Descargando actualización... ${percent}%`
        });
    });

    autoUpdater.on('update-not-available', (info) => {
        sendToRenderer('update-status', {
            state: 'none',
            version: info?.version || '',
            message: 'Azure Launcher ya está actualizado.'
        });
    });

    autoUpdater.on('update-downloaded', (info) => {
        sendToRenderer('update-status', {
            state: 'downloaded',
            version: info?.version || '',
            message: 'Actualización descargada. Reinicia el launcher para instalarla.'
        });
    });

    autoUpdater.on('error', (error) => {
        sendToRenderer('update-status', {
            state: 'error',
            message: `No se pudo comprobar la actualización: ${error?.message || 'Error desconocido'}`
        });
    });
}

RPC.register(DISCORD_CLIENT_ID);

function setDiscordActivity(data = {}) {
    try {
        if (!rpcReady || !rpcClient) return;

        if (data.user) {
            const username = String(data.user || '').trim();
            if (username) {
                currentLaunchVars.username = username;
                lastLaunchUsername = username;
            }
        }

        const usernameDisplayed = currentLaunchVars.username || 'Jugador';

        rpcClient.setActivity({
            details: data.details || 'En el launcher',
            state: data.state || `Usuario: ${usernameDisplayed}`,
            startTimestamp: data.startTimestamp || rpcStartTime,
            largeImageKey: data.largeImageKey || 'azure_logo',
            largeImageText: data.largeImageText || `Usuario: ${usernameDisplayed}`,
            instance: false,
        });
    } catch (error) {
        console.error('Error en Discord RPC:', error.message);
    }
}

function initDiscordRpc() {
    rpcClient = new RPC.Client({ transport: 'ipc' });

    rpcClient.on('ready', () => {
        rpcReady = true;
        console.log('Discord RPC activado');
        setDiscordActivity({
            details: 'Navegando en los menús',
            state: `Usuario: ${currentLaunchVars.username || 'Jugador'}`
        });
    });

    rpcClient.on('disconnected', () => {
        rpcReady = false;
    });

    rpcClient.login({ clientId: DISCORD_CLIENT_ID }).catch((error) => {
        console.warn('Discord RPC no disponible:', error.message);
    });
}

function parseServerAddress(address = '') {
    const cleanAddress = String(address).trim();

    if (!cleanAddress) {
        return { host: '', port: 25565 };
    }

    const parts = cleanAddress.split(':');
    if (parts.length > 1) {
        const port = Number.parseInt(parts.pop(), 10);
        return {
            host: parts.join(':'),
            port: Number.isInteger(port) ? port : 25565
        };
    }

    return { host: cleanAddress, port: 25565 };
}

function normalizeMotd(description) {
    if (!description) return 'Sin descripción';

    if (typeof description === 'string') {
        return description.replace(/§[0-9A-FK-OR]/gi, '').trim();
    }

    if (Array.isArray(description)) {
        return description.map(normalizeMotd).join(' ').replace(/\s+/g, ' ').trim();
    }

    if (Array.isArray(description.extra)) {
        return [description.text || '', ...description.extra.map(normalizeMotd)]
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    if (typeof description.text === 'string') {
        return description.text.replace(/§[0-9A-FK-OR]/gi, '').trim();
    }

    return 'Sin descripción';
}

function buildBasicServer(server = {}) {
    return {
        name: String(server.name || '').replace(/§[0-9A-FK-OR]/gi, '').trim() || 'Servidor sin nombre',
        ip: String(server.ip || '').trim() || '127.0.0.1',
        online: false,
        latency: null,
        playersOnline: 0,
        playersMax: 0,
        version: 'Desconocida',
        motd: 'Cargando estado...'
    };
}

async function enrichServerStatus(server) {
    const { host, port } = parseServerAddress(server.ip);

    if (!host) {
        return {
            ...server,
            online: false,
            latency: null,
            playersOnline: 0,
            playersMax: 0,
            version: 'Sin IP',
            motd: 'Dirección del servidor no válida.'
        };
    }

    try {
        const status = await getStatus(host, port, { timeout: 4000, checkPing: true });

        return {
            ...server,
            online: true,
            latency: typeof status.ping === 'number' ? status.ping : null,
            playersOnline: status.players?.online ?? 0,
            playersMax: status.players?.max ?? 0,
            version: status.version?.name || 'Desconocida',
            motd: normalizeMotd(status.description)
        };
    } catch (error) {
        return {
            ...server,
            online: false,
            latency: null,
            playersOnline: 0,
            playersMax: 0,
            version: 'Offline',
            motd: 'Servidor no disponible en este momento.',
            error: error.message
        };
    }
}

async function exchangeDiscordCodeForUser(code) {
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: DISCORD_CLIENT_ID,
            client_secret: DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
            redirect_uri: DISCORD_REDIRECT_URI,
            scope: 'identify'
        }).toString()
    });

    if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        throw new Error(`Discord token error: ${errorText}`);
    }

    const tokenData = await tokenResponse.json();
    const userResponse = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    if (!userResponse.ok) {
        const errorText = await userResponse.text();
        throw new Error(`Discord user error: ${errorText}`);
    }

    const userData = await userResponse.json();
    const idSuffix = String(userData.id || '')
        .replace(/\D/g, '')
        .slice(-4)
        .padStart(4, '0') || '0000';

    return {
        id: userData.id,
        username: userData.global_name || userData.username,
        discriminator: idSuffix,
        tagSuffix: idSuffix
    };
}

function startDiscordLinkFlow() {
    return new Promise((resolve, reject) => {
        if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
            reject(new Error('Falta la configuración de Discord. Revisa `discord-oauth.local.json` o las variables AZURE_DISCORD_CLIENT_ID y AZURE_DISCORD_CLIENT_SECRET.'));
            return;
        }

        const state = Math.random().toString(36).slice(2);

        if (discordAuthServer) {
            discordAuthServer.close();
            discordAuthServer = null;
        }

        const cleanup = () => {
            if (discordAuthServer) {
                discordAuthServer.close();
                discordAuthServer = null;
            }
        };

        const timeoutId = setTimeout(() => {
            cleanup();
            reject(new Error('La autorización de Discord expiró. Intenta de nuevo.'));
        }, 120000);

        discordAuthServer = http.createServer(async (req, res) => {
            try {
                const requestUrl = new URL(req.url, DISCORD_REDIRECT_URI);

                if (!DISCORD_REDIRECT_PATHS.includes(requestUrl.pathname)) {
                    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('Ruta no encontrada.');
                    return;
                }

                const code = requestUrl.searchParams.get('code');
                const returnedState = requestUrl.searchParams.get('state');

                if (!code || returnedState !== state) {
                    throw new Error('Respuesta inválida de Discord.');
                }

                const userData = await exchangeDiscordCodeForUser(code);
                clearTimeout(timeoutId);

                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<h2>Discord vinculado correctamente. Puedes volver a Azure Launcher.</h2>');

                cleanup();
                resolve(userData);
            } catch (error) {
                clearTimeout(timeoutId);
                res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<h2>No se pudo completar la vinculación con Discord.</h2>');
                cleanup();
                reject(error);
            }
        });

        discordAuthServer.listen(DISCORD_REDIRECT_PORT, () => {
            const authUrl = `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(DISCORD_CLIENT_ID)}&response_type=code&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URI)}&scope=identify&state=${encodeURIComponent(state)}`;
            shell.openExternal(authUrl);
        });

        discordAuthServer.on('error', (error) => {
            clearTimeout(timeoutId);
            cleanup();
            reject(error);
        });
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 700,
        minWidth: 980,
        minHeight: 640,
        resizable: true,
        minimizable: true,
        maximizable: true,
        frame: false, // Launcher sin bordes para más estilo
        autoHideMenuBar: true,
        show: false,
        title: 'Azure Launcher',
        icon: iconPath,
        backgroundColor: '#020b16',
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    mainWindow.removeMenu();
    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        mainWindow.webContents.send('window-state', { isMaximized: mainWindow.isMaximized() });

        if (!app.isPackaged) {
            console.log('AutoUpdater disponible solo en builds instaladas.');
            return;
        }

        setupAutoUpdater();
        setTimeout(() => {
            autoUpdater.checkForUpdates().catch((error) => {
                console.warn('No se pudo iniciar la búsqueda de actualizaciones:', error?.message || error);
            });
        }, 1200);
    });

    mainWindow.on('maximize', () => {
        mainWindow.webContents.send('window-state', { isMaximized: true });
    });

    mainWindow.on('unmaximize', () => {
        mainWindow.webContents.send('window-state', { isMaximized: false });
    });
}

// Version icon functions
const fsExtra = require('fs-extra');

async function saveVersionIcon(version, iconPath) {
    const dest = path.join(launcherConfig.minecraftPath || detectMinecraftPath(), 'versions', version, 'icon.png');
    await fsExtra.ensureDir(path.dirname(dest));
    await fsExtra.copy(iconPath, dest);
}

function getVersionIcon(version) {
    const iconPath = path.join(launcherConfig.minecraftPath || detectMinecraftPath(), 'versions', version, 'icon.png');
    return fs.existsSync(iconPath) ? iconPath : null;
}

app.whenReady().then(() => {
    app.setAppUserModelId('com.azure.launcher');
    createWindow();
    initDiscordRpc();
});

app.on('before-quit', async () => {
    if (rpcClient) {
        try {
            await rpcClient.clearActivity(); // Limpia el estado "Jugando" en Discord
            rpcClient.destroy(); // Destruye la conexión para evitar fugas de memoria
        } catch (error) {
            console.error('Error limpiando Discord RPC:', error.message);
        }
        rpcClient = null;
        rpcReady = false;
    }
});

// CUANDO SE CIERRA LA VENTANA, MATA EL PROCESO POR COMPLETO
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit(); // Cierre definitivo y liberación de memoria
    }
});

// --- FUNCIONES DE ARCHIVOS ---

// 1. Obtener Capturas de Pantalla (del launcher o de la instalación clásica)
ipcMain.handle('get-screenshots', () => {
    const possiblePaths = [
        path.join(rootPath, 'screenshots'),
        path.join(legacyMinecraftPath, 'screenshots')
    ];

    const ssPath = possiblePaths.find((dir) => fs.existsSync(dir));
    if (!ssPath) return [];

    return fs.readdirSync(ssPath)
        .filter(file => file.endsWith('.png') || file.endsWith('.jpg') || file.endsWith('.jpeg'))
        .map(file => path.join(ssPath, file));
});

// 1b. Obtener Servidores (carga rápida de nombre/IP)
ipcMain.handle('get-servers', async () => {
    const userMinecraftPath = getRootPath();
    const windowsRoaming = path.join(os.homedir(), 'AppData', 'Roaming');
    const legacyServersFile = path.join(windowsRoaming, '.minecraft', 'servers.dat');
    const configuredServersFile = path.join(userMinecraftPath, 'servers.dat');
    const launcherServersFile = path.join(windowsRoaming, '.azure_launcher', 'servers.dat');

    const serversFile = fs.existsSync(configuredServersFile)
        ? configuredServersFile
        : fs.existsSync(legacyServersFile)
            ? legacyServersFile
            : fs.existsSync(launcherServersFile)
                ? launcherServersFile
                : fs.existsSync(localServersFile)
                    ? localServersFile
                    : null;

    if (!serversFile) {
        return fallbackServers.map(buildBasicServer);
    }

    try {
        const raw = fs.readFileSync(serversFile);
        const parsedData = await nbt.parse(raw);
        const serversList = Array.isArray(parsedData?.parsed?.value?.servers?.value?.value)
            ? parsedData.parsed.value.servers.value.value
            : [];

        if (serversList.length === 0) {
            return fallbackServers.map(buildBasicServer);
        }

        return serversList.map((server) => buildBasicServer({
            name: server.name?.value || server.name,
            ip: server.ip?.value || server.ip
        }));
    } catch (error) {
        console.error('Error al parsear servers.dat:', error);
        return fallbackServers.map(buildBasicServer);
    }
});

ipcMain.handle('get-server-status', async (_event, server) => {
    try {
        return await enrichServerStatus(buildBasicServer(server));
    } catch (error) {
        return buildBasicServer(server);
    }
});

// ------------ NUEVO: Obtener versiones locales de Minecraft (desde .minecraft/versions) ----
ipcMain.handle('get-local-versions', () => {
    const versionsDir = path.join(rootPath, 'versions');
    if (!fs.existsSync(versionsDir)) return [];

    try {
        return fs.readdirSync(versionsDir).filter((folder) => {
            const jsonPath = path.join(versionsDir, folder, `${folder}.json`);
            return fs.existsSync(jsonPath);
        });
    } catch (err) {
        console.error('Error leyendo versiones locales:', err);
        return [];
    }
});

async function fetchMinecraftVersionMeta(versionId) {
    if (!versionId) return null;
    // Para launcher universal, no necesitamos buscar versiones remotas
    return null;
}

async function installMinecraftVersion(versionId) {
    // Para launcher universal, no instalamos versiones nuevas
    throw new Error('Este launcher universal solo lanza instalaciones existentes. No instala versiones nuevas.');
}

async function installFabricLoader(minecraftVersion, loaderVersion) {
    if (!minecraftVersion || !loaderVersion) {
        throw new Error('La versión de Minecraft y el loader de Fabric son requeridos.');
    }
    return installFabric({
        minecraftVersion,
        version: loaderVersion,
        minecraft: getRootPath()
    });
}

async function installQuiltLoader(minecraftVersion, loaderVersion) {
    if (!minecraftVersion || !loaderVersion) {
        throw new Error('La versión de Minecraft y el loader de Quilt son requeridos.');
    }
    return installQuilt({
        minecraftVersion,
        version: loaderVersion,
        minecraft: getRootPath()
    });
}

async function installForgeLoader(forgeVersion) {
    if (!forgeVersion) {
        throw new Error('La versión de Forge es requerida.');
    }
    return installForge(forgeVersion, getRootPath());
}

async function installNeoForgedLoader(project, version) {
    if (!project || !version) {
        throw new Error('El proyecto y la versión de NeoForged son requeridos.');
    }
    return installForge(project, version, getRootPath()); // NeoForged usa la misma función que Forge
}

// ===== HANDLERS IPC XMCL =====

ipcMain.handle('get-installed-versions', () => {
    return getAllInstallations();
});

ipcMain.handle('install-minecraft-version', async (_event, versionId) => {
    return installMinecraftVersion(versionId);
});

ipcMain.handle('install-fabric-loader', async (_event, { minecraftVersion, loaderVersion }) => {
    return installFabricLoader(minecraftVersion, loaderVersion);
});

ipcMain.handle('install-quilt-loader', async (_event, { minecraftVersion, loaderVersion }) => {
    return installQuiltLoader(minecraftVersion, loaderVersion);
});

ipcMain.handle('install-forge-loader', async (_event, forgeVersion) => {
    return installForgeLoader(forgeVersion);
});

ipcMain.handle('install-neoforged-loader', async (_event, { project, version }) => {
    return installNeoForgedLoader(project, version);
});

ipcMain.handle('get-minecraft-versions-manifest', async () => {
    // Para launcher universal, no necesitamos instalar versiones nuevas
    return [];
});

ipcMain.handle('get-fabric-loaders', async (_event, minecraftVersion) => {
    // Para launcher universal, no necesitamos instalar loaders
    return [];
});

ipcMain.handle('get-quilt-loader-versions', async (_event, minecraftVersion) => {
    // Para launcher universal, no necesitamos instalar loaders
    return [];
});

ipcMain.handle('get-forge-version-list', async (_event, minecraftVersion) => {
    // Para launcher universal, no necesitamos instalar loaders
    return [];
});

ipcMain.handle('clear-cache', async (_event, version = null) => {
    return limpiarCacheMinecraft(version);
});

ipcMain.handle('get-window-state', () => ({
    isMaximized: mainWindow ? mainWindow.isMaximized() : false
}));

ipcMain.handle('get-version-icon', (_event, version) => {
    const minecraftDir = config.minecraftPath || path.join(os.homedir(), '.minecraft');
    const iconPath = path.join(minecraftDir, 'versions', version, 'icon.png');

    if (fs.existsSync(iconPath)) {
        return iconPath;
    }

    return null; // Renderer will use default
});

ipcMain.handle('export-skin', async (_event, { imageData, username }) => {
    const { filePath } = await dialog.showSaveDialog({
        title: 'Exportar Skin de Minecraft',
        defaultPath: path.join(os.homedir(), 'Downloads', `${username || 'player'}_skin.png`),
        filters: [{ name: 'Imágenes PNG', extensions: ['png'] }]
    });

    if (filePath) {
        const base64Data = String(imageData || '').replace(/^data:image\/png;base64,/, '');
        fs.writeFileSync(filePath, base64Data, 'base64');
        return true;
    }
    return false;
});

ipcMain.handle('upload-custom-skin', async (event, username) => {
    try {
        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
            title: 'Sube tu Skin de Minecraft',
            buttonLabel: 'Usar esta Skin',
            filters: [{ name: 'Skins de Minecraft (PNG)', extensions: ['png'] }],
            properties: ['openFile']
        });

        if (canceled || !Array.isArray(filePaths) || filePaths.length === 0) {
            return null;
        }

        const skinsDir = path.join(app.getPath('userData'), 'custom_skins');
        if (!fs.existsSync(skinsDir)) {
            fs.mkdirSync(skinsDir, { recursive: true });
        }

        const safeUsername = String(username || 'player').replace(/[^a-zA-Z0-9_]/g, '');
        const targetPath = path.join(skinsDir, `${safeUsername}.png`);
        fs.copyFileSync(filePaths[0], targetPath);

        const imageBase64 = fs.readFileSync(targetPath, 'base64');
        return `data:image/png;base64,${imageBase64}`;
    } catch (error) {
        console.error('Error subiendo skin:', error);
        return null;
    }
});

ipcMain.on('update-rpc', (_event, data = {}) => {
    setDiscordActivity(data);
});

ipcMain.on('update-discord', (_event, args = {}) => {
    const username = String(args.username || '').trim();
    if (username) {
        currentLaunchVars.username = username;
        lastLaunchUsername = username;
    }

    const status = String(args.status || 'En el menú').trim();
    const version = String(args.version || 'Menú Principal').trim();

    setDiscordActivity({
        details: `Jugando a ${version}`,
        state: `Usuario: ${currentLaunchVars.username || 'Jugador'} - ${status}`,
        largeImageText: `Usuario: ${currentLaunchVars.username || 'Jugador'}`
    });
});

ipcMain.handle('start-discord-link', async () => {
    return await startDiscordLinkFlow();
});

ipcMain.on('restart_app', () => {
    if (!app.isPackaged) {
        sendToRenderer('update-status', {
            state: 'error',
            message: 'La instalación automática solo funciona en la versión instalada del launcher.'
        });
        return;
    }

    autoUpdater.quitAndInstall(false, true);
});

// Configuración
ipcMain.handle('get-config', () => config);
ipcMain.handle('login-microsoft', async () => {
    try {
        const result = await performMicrosoftLogin();
        return {
            success: true,
            account: {
                profile: result.profile,
                accessToken: result.accessToken,
                refreshToken: result.refreshToken || null,
                uuid: result.uuid,
                username: result.username
            }
        };
    } catch (error) {
        console.error('[Microsoft Login]', error);
        return {
            success: false,
            error: error?.message || String(error)
        };
    }
});

ipcMain.handle('set-minecraft-path', (event, newPath) => {
    config.minecraftPath = newPath;
    saveConfig();
    mcFolder = new MinecraftFolder(config.minecraftPath);
    sendToRenderer('config-updated', { minecraftPath: newPath });
    return newPath;
});

ipcMain.handle('set-java-path', (event, newPath) => {
    config.javaPath = newPath;
    saveConfig();
    sendToRenderer('config-updated', { javaPath: newPath });
    return newPath;
});

ipcMain.on('save-gpu-setting', (_event, isDisabled) => {
    config.disableGPU = Boolean(isDisabled);
    saveConfig();
    console.log('Configuración GPU actualizada:', config.disableGPU);
    // Aviso al renderer (opcional) 
    sendToRenderer('gpu-setting-saved', { disableGPU: config.disableGPU });
});

let gameLogs = ""; // Variable global para acumular los logs del juego

// 2. Iniciar Juego (Modo Universal - solo ejecuta instalaciones existentes)
// ===== LANZAMIENTO CON XMCL =====

ipcMain.on('launch-game', async (event, args) => {
    if (isLaunching) {
        const msg = 'Ya se está iniciando Minecraft. Espera un momento.';
        console.warn(msg);
        event.reply('status', msg);
        sendToRenderer('launch-error', { message: msg });
        return;
    }
    isLaunching = true;

    const installationId = args.version;
    const auth = args.auth && args.auth.type === 'premium' && args.auth.accessToken ? args.auth : null;
    const finalUsername = auth?.name || args.username || 'Jugador';

    // Aseguramos que la RAM sea un número limpio y seguro para Windows
    let requestedRam = parseInt(args.ram);
    if (Number.isNaN(requestedRam) || requestedRam < 1) requestedRam = 2;

    const totalMemGB = Math.round(os.totalmem() / (1024 ** 3));
    let maxRamAllowed = 2;

    if (totalMemGB >= 16) maxRamAllowed = 8;
    else if (totalMemGB >= 12) maxRamAllowed = 6;
    else if (totalMemGB >= 8) maxRamAllowed = 4;
    else if (totalMemGB >= 6) maxRamAllowed = 3;
    else maxRamAllowed = 2;

    let ramSize = Math.min(requestedRam, maxRamAllowed);
    if (ramSize < 2) ramSize = 2;

    currentLaunchVars.username = finalUsername;
    currentLaunchVars.version = installationId;

    // Encontrar la instalación seleccionada
    const allInstallations = getAllInstallations();
    const selectedInstallation = allInstallations.find(inst => inst.id === installationId);

    if (!selectedInstallation) {
        const msg = `Instalación ${installationId} no encontrada.`;
        console.error(msg);
        event.reply('status', `Error: ${msg}`);
        sendToRenderer('launch-error', { message: msg });
        isLaunching = false;
        return;
    }

    event.reply('status', `Iniciando ${selectedInstallation.displayName} con ${finalUsername}...`);

    try {
        // Configurar el directorio de Minecraft según el tipo de instalación
        let gamePath;
        let version;

        switch (selectedInstallation.type) {
            case 'local':
                gamePath = mcFolder;
                version = selectedInstallation.id;
                break;
            case 'curseforge':
            case 'modrinth':
            case 'prismlaucher':
                // Para instancias externas, usar el path específico
                gamePath = new MinecraftFolder(selectedInstallation.path);
                // Intentar detectar la versión desde el JSON de instancia
                try {
                    if (selectedInstallation.type === 'curseforge') {
                        const manifest = JSON.parse(fs.readFileSync(path.join(selectedInstallation.path, 'minecraftinstance.json'), 'utf8'));
                        version = manifest.gameVersion;
                    } else if (selectedInstallation.type === 'modrinth') {
                        const profile = JSON.parse(fs.readFileSync(path.join(selectedInstallation.path, 'profile.json'), 'utf8'));
                        version = profile.metadata?.game_version;
                    } else {
                        // PrismLauncher - intentar leer instance.cfg
                        const cfgPath = path.join(selectedInstallation.path, 'instance.cfg');
                        const cfg = fs.readFileSync(cfgPath, 'utf8');
                        const config = {};
                        cfg.split('\n').forEach(line => {
                            const [key, ...value] = line.split('=');
                            if (key && value) config[key.trim()] = value.join('=').trim();
                        });
                        version = config.IntendedVersion;
                    }
                } catch (error) {
                    console.warn(`[XMCL] No se pudo detectar versión automáticamente para ${selectedInstallation.type}, usando auto-detección`);
                    version = selectedInstallation.version || 'auto';
                }
                break;
            default:
                gamePath = mcFolder;
                version = selectedInstallation.id;
        }

        const javaPath = detectJavaVersion();

        // Verificar y descargar librerías faltantes antes del lanzamiento
        event.reply('status', `Verificando librerías para ${selectedInstallation.displayName}...`);
        await ensureLibraries(version, event);

        // Lanzar usando XMCL - maneja automáticamente classpath, JVM args, loaders, etc.
        const launchProcess = await launch(createXmclLaunchOptions({
            version: version,
            gamePath: gamePath.root,
            javaPath: javaPath,
            ramSize: ramSize,
            auth,
            finalUsername
        }));

        event.reply('status', `Cargando ${selectedInstallation.displayName}...`);
        sendToRenderer('launch-status', { status: 'loading', version: selectedInstallation.displayName });
        updateMinecraftPresence('Cargando');

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.hide();
        }

        // Manejar eventos del proceso de XMCL
        launchProcess.on('data', (data) => {
            const line = String(data);
            console.log('[XMCL STDOUT]:', line);
            gameLogs += line + '\n';

            if (!launchSessionFinished && /(Datafixer Bootstrap\/INFO|Render thread\/INFO|Done \()/i.test(line)) {
                setLaunchFinished();
            }

            if (line.includes('Connecting to')) {
                const match = line.match(/Connecting to ([^,]+)/);
                if (match && match[1]) {
                    const serverIP = match[1].trim();
                    updateMinecraftPresence('Multiplayer', serverIP);
                }
            } else if (line.includes('Stopping!') || line.includes('Saving chunks for level') || line.includes('Disconnected') || line.includes('Leaving level')) {
                updateMinecraftPresence('Menu');
            }
        });

        launchProcess.on('error', (error) => {
            const errorMsg = `Error al iniciar Minecraft: ${error?.message || error}`;
            console.error('[XMCL ERROR]:', errorMsg);
            gameLogs += `[ERROR] ${errorMsg}\n`;
            event.reply('status', `Error: ${errorMsg}`);
            sendToRenderer('launch-error', { message: errorMsg });
            isLaunching = false;
        });

        launchProcess.on('close', (code) => {
            console.log(`[XMCL] Minecraft cerrado con código: ${code}`);
            isLaunching = false;
            currentLaunchVars.version = installationId;
            currentLaunchVars.username = finalUsername;
            updateMinecraftPresence('Menu');
            event.reply('status', `${selectedInstallation.displayName} cerrado (código ${code})`);
            sendToRenderer('game-closed', { code });

            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.show();
            }

            if (code !== 0) {
                const summary = gameLogs.split('\n').slice(-15).join('\n');
                mainWindow.webContents.send('game-crash', {
                    code: code,
                    logs: summary
                });
            }
        });

    } catch (error) {
        console.error("[XMCL] FALLO CRÍTICO AL LANZAR:", error);

        let errorMessage = error.message;
        let shouldRetry = false;

        if (error.error === 'MissingLibraries' && error.libraries) {
            // Verificar si son librerías de OptiFine
            const optifineLibs = error.libraries.filter(lib => lib.name && lib.name.includes('optifine'));
            const hasOptifineLibs = optifineLibs.length > 0;

            if (hasOptifineLibs) {
                // Librerías de OptiFine no se pueden descargar automáticamente
                errorMessage = `Esta versión de OptiFine requiere instalación desde el launcher oficial de OptiFine. ` +
                              `Por favor, instala OptiFine desde https://optifine.net/downloads y luego úsala desde este launcher universal. ` +
                              `Librerías faltantes: ${optifineLibs.map(lib => lib.name).join(', ')}`;
            } else {
                // Intentar descargar otras librerías faltantes
                event.reply('status', `Descargando librerías faltantes para ${selectedInstallation.displayName}...`);

                const downloadPromises = error.libraries.map(lib => downloadMissingLibrary(lib, event));
                const results = await Promise.allSettled(downloadPromises);

                const failedDownloads = results.filter(r => r.status === 'rejected' || !r.value).length;

                if (failedDownloads === 0) {
                    // Todas las librerías se descargaron, intentar lanzar nuevamente
                    event.reply('status', `Reintentando lanzamiento de ${selectedInstallation.displayName}...`);
                    shouldRetry = true;
                } else {
                    errorMessage = `No se pudieron descargar ${failedDownloads} librerías necesarias para ${selectedInstallation.displayName}. ` +
                                  `Esta versión puede requerir instalación desde el launcher original.`;
                }
            }
        }

        if (shouldRetry) {
            try {
                // Reintentar el lanzamiento
                const launchProcess = await launch(createXmclLaunchOptions({
                    version: version,
                    gamePath: gamePath.root,
                    javaPath: javaPath,
                    ramSize: ramSize,
                    auth,
                    finalUsername
                }));

                event.reply('status', `Cargando ${selectedInstallation.displayName}...`);
                sendToRenderer('launch-status', { status: 'loading', version: selectedInstallation.displayName });
                updateMinecraftPresence('Cargando');

                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.hide();
                }

                // Manejar eventos del proceso de XMCL
                launchProcess.on('data', (data) => {
                    const line = String(data);
                    console.log('[XMCL STDOUT]:', line);
                    gameLogs += line + '\n';

                    if (!launchSessionFinished && /(Datafixer Bootstrap\/INFO|Render thread\/INFO|Done \()/i.test(line)) {
                        setLaunchFinished();
                    }

                    if (line.includes('Connecting to')) {
                        const ipMatch = line.match(/Connecting to ([^\s,]+)/);
                        if (ipMatch) {
                            updateMinecraftPresence('Playing', ipMatch[1]);
                        }
                    } else if (line.includes('Stopping!')) {
                        updateMinecraftPresence('Menu');
                    }
                });

                launchProcess.on('error', (error) => {
                    const errorMsg = `Error al iniciar Minecraft: ${error?.message || error}`;
                    console.error('[XMCL ERROR]:', errorMsg);
                    gameLogs += `[ERROR] ${errorMsg}\n`;
                    event.reply('status', `Error: ${errorMsg}`);
                    sendToRenderer('launch-error', { message: errorMsg });
                    isLaunching = false;
                });

                launchProcess.on('close', (code) => {
                    console.log(`[XMCL] Minecraft cerrado con código: ${code}`);
                    isLaunching = false;
                    currentLaunchVars.version = installationId;
                    currentLaunchVars.username = finalUsername;
                    updateMinecraftPresence('Menu');
                    event.reply('status', `${selectedInstallation.displayName} cerrado (código ${code})`);
                    sendToRenderer('game-closed', { code });

                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.show();
                    }

                    if (code !== 0) {
                        sendToRenderer('launch-error', { message: `Minecraft se cerró con código de error: ${code}` });
                    }
                });

                return; // Salir exitosamente del reintento
            } catch (retryError) {
                console.error("[XMCL] FALLO EN REINTENTO:", retryError);
                errorMessage = `Error incluso después de descargar librerías: ${retryError.message}`;
            }
        }

        isLaunching = false;
        event.reply('status', 'Error: ' + errorMessage);
        sendToRenderer('launch-error', { message: errorMessage });
    }
});


ipcMain.on('close-launcher-after-start', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        app.quit(); // Cambiamos mainWindow.hide() por app.quit() para liberar rendimiento
    }
});

// ===== HANDLERS ADICIONALES =====

// Listener para actualizar nombre de usuario en tiempo real
ipcMain.on('update-username', (event, newUsername) => {
    const user = String(newUsername || 'Jugador').trim() || 'Jugador';
    currentLaunchVars.username = user;
    lastLaunchUsername = user;

    setDiscordActivity({
        details: 'En el Launcher',
        state: `Usuario: ${currentLaunchVars.username}`,
        largeImageText: `Usuario: ${currentLaunchVars.username}`
    });
});

// Controles de ventana
ipcMain.on('window-control', (e, action) => {
    if (!mainWindow) return;

    if (action === 'close') mainWindow.close();
    if (action === 'min') mainWindow.minimize();
    if (action === 'max') {
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
    }
});

// Listener para abrir el explorador de archivos y buscar javaw.exe
ipcMain.handle('select-java', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Selecciona el ejecutable de Java (javaw.exe)',
        properties: ['openFile'],
        filters: [
            { name: 'Ejecutables de Java', extensions: ['exe'] }
        ]
    });

    if (canceled) return null;
    return filePaths[0]; // Devuelve la ruta seleccionada
});

// Listener para seleccionar directorio de Minecraft
ipcMain.handle('select-directory', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Selecciona el directorio de Minecraft (.minecraft)',
        properties: ['openDirectory']
    });

    if (canceled) return null;
    return filePaths[0]; // Devuelve la ruta seleccionada
});

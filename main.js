const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const { Client, Authenticator } = require('minecraft-launcher-core');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const nbt = require('prismarine-nbt');
const { getStatus } = require('mc-server-status');
const RPC = require('discord-rpc');
const { exec } = require('child_process');

const launcher = new Client();

// Agregar listeners globales para debug del core de Minecraft
launcher.on('debug', (e) => console.log('[DEBUG CORE]:', e));
launcher.on('data', (e) => {
    const message = String(e || '');
    console.log('[DATA CORE]:', message);

    if (!launchSessionFinished && /(Datafixer Bootstrap\/INFO|Render thread\/INFO|Done \()/i.test(message)) {
        setLaunchFinished();
    }
});
launcher.on('error', (e) => console.error('[ERROR CORE]:', e));
launcher.on('close', (e) => console.log('[CERRADO CORE]: Código de salida', e));
launcher.on('download-status', (e) => {
    const percent = e.totalBytes > 0 ? Math.round((e.downloadedBytes / e.totalBytes) * 100) : 0;
    console.log(`[DESCARGANDO]: ${e.type} - ${e.name} | Progreso: ${percent}%`);
    sendToRenderer('launch-progress', {
        type: e.type,
        name: e.name,
        percent
    });
});

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
    const root = rootPath; // Usar rootPath consistente
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

const rootPath = path.join(appData, '.minecraft');
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
            details: data.details || 'Navegando',
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

app.whenReady().then(() => {
    app.setAppUserModelId('com.azure.launcher');
    createWindow();
    initDiscordRpc();
});

app.on('before-quit', async () => {
    if (!rpcClient) return;

    try {
        await rpcClient.clearActivity();
    } catch (error) {
        // Ignorar si Discord no está abierto.
    }

    rpcClient.destroy();
    rpcClient = null;
    rpcReady = false;
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
    const windowsRoaming = path.join(os.homedir(), 'AppData', 'Roaming');
    const legacyServersFile = path.join(windowsRoaming, '.minecraft', 'servers.dat');
    const launcherServersFile = path.join(windowsRoaming, '.azure_launcher', 'servers.dat');

    const serversFile = fs.existsSync(legacyServersFile)
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
        const parsedData = await new Promise((resolve, reject) => {
            nbt.parse(raw, (error, data) => {
                if (error) reject(error);
                else resolve(data);
            });
        });

        const simplified = nbt.simplify(parsedData);
        const serversList = Array.isArray(simplified?.servers) ? simplified.servers : [];

        if (serversList.length === 0) {
            return fallbackServers.map(buildBasicServer);
        }

        return serversList.map((server) => buildBasicServer({
            name: server.name,
            ip: server.ip
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
    const dotMinecraft = path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft', 'versions');
    if (!fs.existsSync(dotMinecraft)) return [];

    try {
        return fs.readdirSync(dotMinecraft).filter((folder) => {
            const jsonPath = path.join(dotMinecraft, folder, `${folder}.json`);
            return fs.existsSync(jsonPath);
        });
    } catch (err) {
        console.error('Error leyendo versiones locales:', err);
        return [];
    }
});

// ------------ NUEVO: Obtener versiones instaladas de Minecraft ----------------
ipcMain.handle('get-installed-versions', () => {
    const versionsPath = path.join(rootPath, 'versions');
    if (!fs.existsSync(versionsPath)) return [];
    
    try {
        let versions = fs.readdirSync(versionsPath).filter((folder) => {
            const jsonPath = path.join(versionsPath, folder, `${folder}.json`);
            return fs.existsSync(jsonPath);
        });

        versions.sort((a, b) => {
            const cleanA = a.replace(/[^0-9.]/g, '');
            const cleanB = b.replace(/[^0-9.]/g, '');
            const pa = cleanA.split('.').map(Number);
            const pb = cleanB.split('.').map(Number);
            for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
                const na = pa[i] || 0;
                const nb = pb[i] || 0;
                if (na > nb) return -1;
                if (na < nb) return 1;
            }
            return 0;
        });

        return versions;
    } catch (err) {
        console.error('Error leyendo versiones:', err);
        return [];
    }
});

ipcMain.handle('clear-cache', async (_event, version = null) => {
    return limpiarCacheMinecraft(version);
});

ipcMain.handle('get-window-state', () => ({
    isMaximized: mainWindow ? mainWindow.isMaximized() : false
}));

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

let gameLogs = ""; // Variable global para acumular los logs del juego

// 2. Iniciar Juego
ipcMain.on('launch-game', async (event, args) => {
    if (isLaunching) return;
    isLaunching = true;

    const selectedVersion = args.version;
    const javaPath = args.javaPath;

    // Aseguramos que la RAM sea un número limpio
    const ramSize = parseInt(args.ram) || 4;

    // Definimos el nombre final correctamente
    const finalUsername = args.username || 'Jugador';
    currentLaunchVars.username = finalUsername;
    currentLaunchVars.version = args.version || '';
    lastLaunchUsername = finalUsername;

    const versionPath = path.join(rootPath, 'versions', selectedVersion);
    if (!fs.existsSync(versionPath)) {
        const msg = `Versión ${selectedVersion || 'desconocida'} no está instalada. Revisa que esté en ${versionPath}.`;
        console.warn(msg);
        event.reply('status', `Error: ${msg}`);
        isLaunching = false;
        return;
    }

    const effectiveJavaPath = javaPath || 'java';
    if (!fs.existsSync(effectiveJavaPath) && effectiveJavaPath.toLowerCase() !== 'java') {
        const warning = `Ruta de JAVA no existe: ${effectiveJavaPath}. La ejecución puede fallar.`;
        console.warn(warning);
        event.reply('status', warning);
    }

    // Verificar versión de Java para versiones modernas
    const versionNumber = parseFloat(selectedVersion.replace(/[^\d.]/g, ''));
    if (versionNumber >= 1.17) { // 1.17+ requiere Java 16+, 1.20 requiere 17+
        const javaVersion = await verificarVersionJava(effectiveJavaPath);
        if (!javaVersion || javaVersion.major < 17) {
            const msg = `Minecraft ${selectedVersion} requiere Java 17+. Detectado: ${javaVersion ? javaVersion.full : 'desconocido'}. Actualiza Java.`;
            console.error(msg);
            event.reply('status', `Error: ${msg}`);
            isLaunching = false;
            return;
        }
    }

    event.reply('status', `Iniciando Minecraft ${selectedVersion} con ${finalUsername}...`);

    const auth = Authenticator.getAuth(currentLaunchVars.username || finalUsername);

    let opts = {
        clientPackage: null,
        authorization: Authenticator.getAuth(currentLaunchVars.username || finalUsername),
        root: rootPath,
        version: {
            number: currentLaunchVars.version || selectedVersion,
            type: 'release'
        },
        javaPath: effectiveJavaPath,
        memory: {
            max: `${ramSize}G`,
            min: "1G"
        }
    };

    // El launcher NO se oculta aún; debe permanecer visible mientras se preparan archivos y se descargan assets.
    currentLaunchVars.username = finalUsername;
    currentLaunchVars.version = selectedVersion;

    const versionLimpia = formatearDetallesVersion(selectedVersion);

    updateMinecraftPresence('Menu');

    // Reiniciar log de juego antes de lanzar
    gameLogs = "";

    try {
        console.log(`Intentando lanzar ${selectedVersion}...`);
        const handler = await launcher.launch(opts);

        if (!handler) {
            throw new Error('No se pudo iniciar el proceso de Minecraft (handler nulo)');
        }

        handler.on('debug', (data) => {
            const line = `[DEBUG] ${String(data)}`;
            console.log(line);
            gameLogs += line + '\n';
        });

        handler.on('error', (error) => {
            const errorMsg = `Minecraft error: ${error?.message || error}`;
            console.error(errorMsg);
            gameLogs += `[ERROR] ${errorMsg}\n`;
            event.reply('status', `Error: ${errorMsg}`);
            sendToRenderer('launch-error', { message: errorMsg });
            isLaunching = false;
        });

        let launchFinishedSent = false;

        handler.on('data', (raw) => {
            const line = String(raw || '');
            console.log(line);
            gameLogs += line + '\n';

            if (!launchFinishedSent && /(Datafixer Bootstrap\/INFO|Render thread\/INFO|Done \()/i.test(line)) {
                launchFinishedSent = true;
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

        handler.on('close', (code) => {
            isLaunching = false;
            currentLaunchVars.version = selectedVersion;
            currentLaunchVars.username = finalUsername;
            updateMinecraftPresence('Menu');
            event.reply('status', `Minecraft cerrado (código ${code})`);

            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.show();
            }
        });

        event.reply('status', '¡Lanzando Minecraft!');

    } catch (error) {
        console.error("FALLO CRÍTICO AL LANZAR:", error);
        isLaunching = false; // <--- ESTO DESBLOQUEA LOS BOTONES SI FALLA
        event.reply('status', 'Error: ' + error.message);
        sendToRenderer('launch-error', { message: error.message });
    }
});

ipcMain.on('close-launcher-after-start', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
        // app.quit(); // descomentar si quieres cerrar completamente el proceso del launcher
    }
});

launcher.on('close', (code) => {
    console.log('Juego cerrado con código:', code);
    isLaunching = false; // Resetear el estado de lanzamiento

    if (gameLogInterval) {
        clearInterval(gameLogInterval);
        gameLogInterval = null;
    }

    if (mainWindow) {
        mainWindow.show();

        if (code !== 0) {
            const summary = gameLogs.split('\n').slice(-15).join('\n');
            mainWindow.webContents.send('game-crash', {
                code: code,
                logs: summary
            });
        } else {
            mainWindow.webContents.send('status', 'Juego cerrado correctamente.');
        }
    }

    // Actualizamos Discord al cerrar con el nombre correcto
    setDiscordActivity({
        details: 'Navegando en los menús',
        state: `Usuario: ${currentLaunchVars.username || 'Jugador'}`,
        largeImageKey: 'azure_logo'
    });
});

// --- AÑADE ESTE NUEVO LISTENER PARA EL NOMBRE EN TIEMPO REAL ---
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
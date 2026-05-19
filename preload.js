const { contextBridge, ipcRenderer, clipboard, nativeImage } = require('electron');

// Exponer APIs seguras al renderer
contextBridge.exposeInMainWorld('api', {
    // --- NUEVO: Función unificada para la barra de título (Arregla el error de index.html) ---
    controlWindow: (action) => {
        const validActions = ['min', 'max', 'close'];
        if (validActions.includes(action)) {
            ipcRenderer.send(`window:${action === 'min' ? 'minimize' : action === 'max' ? 'maximize' : 'close'}`);
        }
    },

    // --- NUEVO: Métodos genéricos para que 'const ipc = api' funcione en renderer.js ---
    send: (channel, data) => {
        ipcRenderer.send(channel, data);
    },
    invoke: (channel, data) => {
        return ipcRenderer.invoke(channel, data);
    },
    on: (channel, callback) => {
        ipcRenderer.on(channel, (event, ...args) => callback(...args));
    },

    // Funciones específicas (las que ya tenías)
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),

    // Versiones y Configuración
    createInstallation: () => ipcRenderer.invoke('create-installation'),
    editVersion: (id) => ipcRenderer.invoke('edit-version', id),
    deleteVersion: (id) => ipcRenderer.invoke('delete-version', id),
    getConfig: () => ipcRenderer.invoke('get-config'),
    setMinecraftPath: (path) => ipcRenderer.invoke('set-minecraft-path', path),
    setJavaPath: (path) => ipcRenderer.invoke('set-java-path', path),

    // Login y Lanzamiento
    loginMicrosoft: () => ipcRenderer.invoke('login-microsoft'),
    startDiscordLink: () => ipcRenderer.invoke('start-discord-link'),
    launchGame: (args) => ipcRenderer.send('launch-game', args),
    getLocalVersions: () => ipcRenderer.invoke('get-local-versions'),
    getMinecraftVersionsManifest: () => ipcRenderer.invoke('get-minecraft-versions-manifest'),
    installMinecraftVersion: (versionId) => ipcRenderer.invoke('install-minecraft-version', versionId),

    // Otros
    updatePresence: (presence) => ipcRenderer.send('update-presence', presence),
    copyImageToClipboard: (path) => {
        try {
            const image = nativeImage.createFromPath(path);
            if (image.isEmpty()) throw new Error('Imagen vacía');
            clipboard.writeImage(image);
            return true;
        } catch (error) {
            console.error('Error en portapapeles:', error);
            return false;
        }
    },
    logToTerminal: (...args) => ipcRenderer.send('logs-al-terminal', args)
});
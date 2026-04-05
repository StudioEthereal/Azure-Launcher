const { ipcRenderer, clipboard, nativeImage } = require('electron');
const ipc = ipcRenderer;

// skinview3d se carga desde CDN en index.html (window.skinview3d). No usar require() en Electron renderer por incompatibilidades ESM.

// Firebase imports (comentados temporalmente para probar)
// const { initializeApp, getApps, getApp } = require('firebase/app');
// const { getDatabase, ref, set, onValue, remove, update, off, get } = require('firebase/database');
// const { getStorage, ref: storageRef, uploadBytes, getDownloadURL } = require('firebase/storage');

// --- VARIABLES GLOBALES ---
let firebaseDb = null;
let firebaseFns = null;
let firebaseReady = false;
let friendsRealtimeUnsubs = [];
let activeFriendsIdentity = '';
let friendsPresenceInterval = null;
let cachedFriendsPresence = {};
const DEFAULT_FRIEND_SERVERS = ['play.azuremc.net', 'mc.hypixel.net', 'survival.latam.com'];

let versionSeleccionada = ""; // Variable global para la versión elegida
let pendingLoginType = 'offline'; // 'offline' o 'premium'

// Persistencia para aliases / ocultar versiones
let versionProfiles = JSON.parse(localStorage.getItem('azure_version_profiles') || '[]');
let currentEditId = null;
let pendingDeleteVersionId = null; // ID de la instalación pendiente de eliminación
let pendingDeleteIndex = null; // ID de cuenta (método viejo)
let pendingConfirmAction = null;
let pendingIconProfileId = null;

// --- CONFIGURACIÓN DE FIREBASE ---
// const FIREBASE_CONFIG = {
//     apiKey: 'AIzaSyCrNo2X1qyL5fs-daXIPGZVsC7mqiJqVRU',
//     authDomain: 'azurelauncher.firebaseapp.com',
//     databaseURL: 'https://azurelauncher-default-rtdb.firebaseio.com',
//     projectId: 'azurelauncher',
//     storageBucket: 'azurelauncher.firebasestorage.app',
//     messagingSenderId: '77647179819',
//     appId: '1:77647179819:web:7ace2a6365cd06a657ba6e'
// };

// Inicialización Segura (comentada temporalmente)
// try {
//     const app = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
//     firebaseDb = getDatabase(app);
//     firebaseFns = { ref, set, onValue, remove, update, off, get };
//     firebaseReady = true;

//     window.fbSet = set;
//     window.fbRef = ref;
//     window.fbOnValue = onValue;
//     window.fbRemove = remove;
//     window.fbUpdate = update;

//     console.log('✅ Firebase Cargado');
// } catch (e) {
//     console.error('❌ Error cargando Firebase:', e);
// }

// Skin viewer variables
let skinViewer;
let currentSkinPath = null;
let currentModel = "default"; // steve

// Cape variables
let currentCapeFile = null;

// Initialize skin viewer
function initSkinViewer() {
    const canvas = document.getElementById("skin-viewer-canvas");

    skinViewer = new skinview3d.SkinViewer({
        canvas: canvas,
        width: 300,
        height: 400,
        skin: "https://minotar.net/skin/Steve"
    });

    skinViewer.controls.enableZoom = true;
    skinViewer.controls.enableRotate = true;

    skinview3d.createOrbitControls(skinViewer);

    const idle = skinview3d.createAnimation(skinViewer, skinview3d.WalkingAnimation);
    idle.speed = 0.5;
}

// Handle skin upload
function manejarSubidaDeSkin(event) {
    const file = event.target.files[0];
    if (!file) return;

    const url = URL.createObjectURL(file);
    currentSkinPath = url;

    skinViewer.loadSkin(url);

    document.getElementById("status-text").textContent = "Skin cargada correctamente";
    document.getElementById("step-4-container").style.opacity = "1";
}

// Upload skin to Firebase
async function uploadSkin(uuid) {
    if (!currentSkinFile) return;

    const fileRef = storageRef(storage, `skins/${uuid}.png`);
    await uploadBytes(fileRef, currentSkinFile);
    const url = await getDownloadURL(fileRef);

    await firebaseFns.set(firebaseFns.ref(firebaseDb, `users/${uuid}`), {
        skinUrl: url,
        model: currentModel,
        updated: Date.now()
    });

    return url;
}

// Load skin from Firebase
async function loadFirebaseSkin(uuid) {
    const snapshot = await firebaseFns.get(firebaseFns.ref(firebaseDb, `users/${uuid}`));
    if (snapshot.exists()) {
        const data = snapshot.val();
        skinViewer.loadSkin(data.skinUrl, { model: data.model });
    }
}

// Load skin (premium or Firebase)
async function loadSkin(uuid) {
    try {
        const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`);
        if (res.ok) {
            loadPremiumSkin(uuid);
            return;
        }
    } catch (e) {}

    await loadFirebaseSkin(uuid);
}

// Set model functions
function setClassicModel() {
    currentModel = "default";
    skinViewer.loadSkin(currentSkinPath, {
        model: "default"
    });

    document.getElementById("m-classic").classList.add("active");
    document.getElementById("m-slim").classList.remove("active");
}

function setSlimModel() {
    currentModel = "slim";
    skinViewer.loadSkin(currentSkinPath, {
        model: "slim"
    });

    document.getElementById("m-classic").classList.remove("active");
    document.getElementById("m-slim").classList.add("active");
}

// Load premium skin
function loadPremiumSkin(uuid) {
    const url = `https://crafatar.com/skins/${uuid}`;
    skinViewer.loadSkin(url);
}

// Load current account skin into viewer
async function loadCurrentAccountSkin() {
    if (!currentAccount || !skinViewer) return;

    const uuid = currentAccount.uuid || currentAccount.name;
    await loadSkin(uuid);
    await loadFirebaseCape(uuid);
}

// Select model
function selectModel(model) {
    if (model === 'classic') {
        setClassicModel();
    } else if (model === 'slim') {
        setSlimModel();
    }
}

// Cape functions
function manejarSubidaDeCape(e) {
    const file = e.target.files[0];
    if (!file) return;

    currentCapeFile = file;
    // Preview cape if needed
}

async function uploadCape(uuid) {
    if (!currentCapeFile) return;

    const fileRef = storageRef(storage, `capes/${uuid}.png`);
    await uploadBytes(fileRef, currentCapeFile);
    const url = await getDownloadURL(fileRef);

    await firebaseFns.set(firebaseFns.ref(firebaseDb, `users/${uuid}`), {
        ...await firebaseFns.get(firebaseFns.ref(firebaseDb, `users/${uuid}`)).then(s => s.val() || {}),
        capeUrl: url,
        updated: Date.now()
    });

    return url;
}

async function loadFirebaseCape(uuid) {
    const snapshot = await firebaseFns.get(firebaseFns.ref(firebaseDb, `users/${uuid}`));
    if (snapshot.exists()) {
        const data = snapshot.val();
        if (data.capeUrl) {
            // Load cape into viewer or game
            console.log('Cape loaded:', data.capeUrl);
        }
    }
}

// Auto link Discord
async function autoLinkDiscord(account) {
    try {
        // Obtener tokens de Discord guardados
        const tokens = JSON.parse(localStorage.getItem('discord_tokens') || '{}');
        if (tokens.access_token) {
            const response = await fetch('https://discord.com/api/users/@me', {
                headers: {
                    'Authorization': `Bearer ${tokens.access_token}`
                }
            });
            if (response.ok) {
                const discordUser = await response.json();

                // Vincular automáticamente
                const linkData = {
                    minecraft: account.name,
                    uuid: account.uuid,
                    discordId: discordUser.id,
                    discordUsername: discordUser.username,
                    linkedAt: Date.now()
                };

                localStorage.setItem('discord_link', JSON.stringify(linkData));
                localStorage.setItem('discord_user', `${discordUser.username}#${discordUser.discriminator || '0000'}`);

                // Guardar en Firebase si está disponible
                if (firebaseReady) {
                    await firebaseFns.set(firebaseFns.ref(firebaseDb, `users/${account.uuid}`), {
                        ...await firebaseFns.get(firebaseFns.ref(firebaseDb, `users/${account.uuid}`)).then(s => s.val() || {}),
                        discordId: discordUser.id,
                        username: account.name,
                        linkedAt: Date.now()
                    });
                }

                showToast('Cuenta vinculada automáticamente con Discord.', 'success');
            }
        }
    } catch (error) {
        console.log('No se pudo vincular Discord automáticamente:', error);
    }
}

const STANDARD_MINECRAFT_BLOCKS = [
    { name: 'Mesa de crafteo', path: 'assets/blocks/crafting_table.png' },
    { name: 'Cofre', path: 'assets/blocks/chest.png' },
    { name: 'Horno', path: 'assets/blocks/furnace.png' },
    { name: 'Diamante', path: 'assets/blocks/diamond_block.png' },
    { name: 'Oro', path: 'assets/blocks/gold_block.png' },
    { name: 'Hierba', path: 'assets/blocks/grass_block.png' },
    { name: 'Tierra', path: 'assets/blocks/dirt_block.png' },
    { name: 'Piedra', path: 'assets/blocks/stone.png' },
    { name: 'Ladrillos', path: 'assets/blocks/bricks.png' },
    { name: 'Redstone', path: 'assets/blocks/redstone_block.png' }
];

// === FIX DE CARGA DE SKIN Y VISOR 3D ===
let globalSkinViewer = null;

window.manejarSubidaDeSkin = manejarSubidaDeSkin;

window.renderizarSkin3D = function(skinURL) {
    const canvas = document.getElementById('skin-viewer-canvas');
    if (!canvas) {
        console.error("No se encontró el canvas 'skin-viewer-canvas'");
        return;
    }

    try {
        if (globalSkinViewer) {
            globalSkinViewer.dispose();
        }

        const skinview3d = window.skinview3d;
        if (!skinview3d) {
            console.error('La librería skinview3d no se ha cargado desde el CDN.');
            return;
        }

        const w = canvas.clientWidth || 300;
        const h = canvas.clientHeight || 400;
        canvas.width = w;
        canvas.height = h;

        globalSkinViewer = new skinview3d.SkinViewer({
            canvas: canvas,
            width: w,
            height: h,
            skin: skinURL
        });

        globalSkinViewer.animation = new skinview3d.WalkingAnimation();
        globalSkinViewer.animation.speed = 0.6;
        globalSkinViewer.autoRotate = true;
        globalSkinViewer.autoRotateSpeed = 0.5;

    } catch (err) {
        console.error('Error crítico en el render 3D:', err);
    }
};

function saveVersionProfiles() {
    localStorage.setItem('azure_version_profiles', JSON.stringify(versionProfiles));
}

function getVersionProfile(version) {
    return versionProfiles.find(p => p.version === version);
}

function getMergedVersionItems(installedVersions) {
    const profileMap = {};
    versionProfiles.forEach(item => {
        profileMap[item.version] = item;
    });

    const merged = [];

    installedVersions.forEach(v => {
        const profile = profileMap[v];
        if (profile?.hidden) return;
        merged.push({
            id: profile?.id || v,
            version: v,
            alias: profile?.alias || v,
            installed: true
        });
    });

    Object.values(versionProfiles).forEach(profile => {
        if (installedVersions.includes(profile.version)) return; // ya está
        if (profile.hidden) return;
        merged.push({
            id: profile.id,
            version: profile.version,
            alias: profile.alias || profile.version,
            installed: false
        });
    });

    return merged;
}

function getVersionItemById(id, items) {
    return items.find(it => it.id === id || it.version === id);
}

function getVersionLabel(version) {
    const profile = getVersionProfile(version);
    return profile?.alias || version;
}

function migrateLegacyVersionList() {
    const legacyVersions = JSON.parse(localStorage.getItem('azureVersions') || '[]');
    if (!Array.isArray(legacyVersions) || legacyVersions.length === 0) return;

    let changed = false;
    legacyVersions.forEach((version) => {
        if (!versionProfiles.some((p) => p.version === version)) {
            versionProfiles.push({
                id: `vp-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
                version,
                alias: version,
                hidden: false
            });
            changed = true;
        }
    });

    if (changed) {
        saveVersionProfiles();
    }
}



// Inicialización Segura
try {
    const { initializeApp, getApps, getApp } = require('firebase/app');
    const { getDatabase, ref: dbRef, set, onValue, remove, update, off, get } = require('firebase/database');
    const { getStorage, ref: storageRef, uploadBytes, getDownloadURL } = require('firebase/storage');

    const app = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
    firebaseDb = getDatabase(app);
    firebaseFns = { dbRef, set, onValue, remove, update, off, get };
    firebaseReady = true;

    window.fbSet = set;
    window.fbRef = dbRef;
    window.fbOnValue = onValue;
    window.fbRemove = remove;
    window.fbUpdate = update;
    window.fbGet = get;
    window.firebaseStorage = getStorage(app);
    window.fbStorage = window.firebaseStorage;
    window.fbStorageRef = storageRef;
    window.fbUploadBytes = uploadBytes;
    window.fbGetDownloadURL = getDownloadURL;

    console.log('✅ Firebase Cargado');
} catch (e) {
    console.error('❌ Error cargando Firebase:', e);
}

// Función para limpiar nombres (Firebase no acepta puntos o hashtags en las llaves)
const clean = (tag) => String(tag || '').replace(/[.#$[\]]/g, '_');
const cleanKey = clean;

// Función para controlar la ventana (minimizar, maximizar, cerrar)
function controlWindow(action) {
    ipc.send('window-control', action);
}

// Esta función le dice a tus amigos qué estás haciendo
async function updateMyPresence() {
    const myTag = localStorage.getItem('discord_user') || getLinkedIdentity();
    if (!myTag || !firebaseReady || !window.fbUpdate || !window.fbRef || !firebaseDb) return;

    const myKey = clean(myTag);
    const now = Date.now();

    try {
        await window.fbUpdate(window.fbRef(firebaseDb, `perfiles/${myKey}`), {
            lastSeen: now,
            status: 'online',
            currentServer: localStorage.getItem('last_server') || 'Menú Principal'
        });
        console.log('📡 Presencia actualizada');
    } catch (e) {
        console.error('Error al actualizar presencia:', e);
    }
}

// Configurar para que se actualice cada 30 segundos automáticamente
setInterval(() => {
    if (firebaseReady) updateMyPresence();
}, 30000);

// Aplicar color guardado en localStorage (persistencia)
const savedAccent = localStorage.getItem('azureAccentColor')
    || localStorage.getItem('themeColor')
    || localStorage.getItem('launcher-accent');

if (savedAccent) {
    setLauncherAccent(savedAccent);
}

let pendingColor = null;
let serverRefreshInterval = null;
const COUNTRY_CACHE_KEY = 'azureCountryCache';
let currentAccount = null;
let activeSection = 'play';

let skinLibrary = [];
let currentSkinDataUrl = null;

// Variable global para no crear el visor múltiples veces
let miVisor3D = null;

let privacyServerCache = [];
let privacyHiddenServerIps = new Set(JSON.parse(localStorage.getItem('azureHiddenServers') || '[]'));
let isShareTopServers = localStorage.getItem('azureShareTopServers') === 'true';
let isHideLocalTime = localStorage.getItem('azureHideLocalTime') === 'true';
let favoriteScreenshot = localStorage.getItem('azureFavoriteScreenshot') || '';

function savePrivacyHiddenServers() {
    localStorage.setItem('azureHiddenServers', JSON.stringify(Array.from(privacyHiddenServerIps)));
}

function saveSecuritySettings() {
    localStorage.setItem('azureShareTopServers', String(isShareTopServers));
    localStorage.setItem('azureHideLocalTime', String(isHideLocalTime));
}

function setFavoriteScreenshot(path) {
    favoriteScreenshot = String(path || '').trim();
    localStorage.setItem('azureFavoriteScreenshot', favoriteScreenshot);
    updatePrivacyControls();
    showToast('Captura favorita actualizada');
}

function updatePrivacyControls() {
    const shareSwitch = document.getElementById('switch-share-top');
    const hideTimeSwitch = document.getElementById('switch-hide-time');
    const favPath = document.getElementById('favorite-capture-path');
    const favThumb = document.getElementById('favorite-capture-thumb');

    if (shareSwitch) {
        if (isShareTopServers) {
            shareSwitch.classList.add('on');
        } else {
            shareSwitch.classList.remove('on');
        }
    }
    if (hideTimeSwitch) {
        if (isHideLocalTime) {
            hideTimeSwitch.classList.add('on');
        } else {
            hideTimeSwitch.classList.remove('on');
        }
    }
    if (favPath) favPath.innerText = favoriteScreenshot ? favoriteScreenshot.split(/[\\/]/).pop() : 'Ninguna seleccionada';

    if (favThumb) {
        if (favoriteScreenshot) {
            favThumb.src = `file://${favoriteScreenshot}`;
            favThumb.style.display = 'block';
        } else {
            favThumb.style.display = 'none';
            favThumb.src = '';
        }
    }
}

function savePrivacyHiddenServers() {
    localStorage.setItem('azureHiddenServers', JSON.stringify(Array.from(privacyHiddenServerIps)));
}

async function loadPrivacyServers() {
    try {
        const servers = await ipc.invoke('get-servers');
        privacyServerCache = Array.isArray(servers) ? servers : [];
    } catch (e) {
        console.error('Error cargando servidores para privacidad:', e);
        privacyServerCache = [];
    }
    renderPrivacyServers();
    updatePrivacyControls();
}

function toggleShareTopServers() {
    isShareTopServers = !isShareTopServers;
    saveSecuritySettings();
    updatePrivacyControls();
    loadPrivacyServers();
}

function toggleHideLocalTime() {
    isHideLocalTime = !isHideLocalTime;
    saveSecuritySettings();
    updatePrivacyControls();
    syncPresenceToFirebase();
}

function openFavoriteCaptureModal() {
    const modal = document.getElementById('favorite-capture-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    loadFavoriteCaptures();
}

function closeFavoriteCaptureModal() {
    const modal = document.getElementById('favorite-capture-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    // Mantener el modal de privacidad visible, si estaba abierto
    const privacyModal = document.getElementById('privacy-settings-modal');
    if (privacyModal) privacyModal.classList.remove('hidden');
}

async function loadFavoriteCaptures() {
    const grid = document.getElementById('favorite-capture-grid');
    if (!grid) return;
    grid.innerHTML = '<p style="color:#c9e6ff;">Cargando capturas...</p>';

    try {
        const paths = await ipc.invoke('get-screenshots');
        if (!Array.isArray(paths) || paths.length === 0) {
            grid.innerHTML = '<p style="color:#c9e6ff;">No se encontraron capturas disponibles.</p>';
            return;
        }

        grid.innerHTML = paths.map((path) => `
            <div style="display:flex; flex-direction:column; gap:5px; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; overflow: hidden; background: rgba(0,0,0,0.25);">
                <img src="file://${path}" alt="${path}" style="width:100%; height:90px; object-fit: cover;"> 
                <button class="btn-primary" style="font-size: 0.75rem; width:100%;" onclick="selectFavoriteCapture('${encodeURI(path)}')">Marcar favorita</button>
            </div>
        `).join('');
    } catch (e) {
        console.error('Error cargando capturas para favorita:', e);
        grid.innerHTML = '<p style="color:#ff9393;">Error al cargar capturas.</p>';
    }
}

function selectFavoriteCapture(encodedPath) {
    const path = decodeURI(encodedPath);
    setFavoriteScreenshot(path);
    updatePrivacyControls();
    syncPresenceToFirebase();
    showToast('Captura favorita configurada correctamente');
    closeFavoriteCaptureModal();
}

function establecerCapturaFavorita() {
    if (!currentSSPath) {
        showToast('Primero selecciona una captura.');
        return;
    }
    setFavoriteScreenshot(currentSSPath);
    syncPresenceToFirebase();
    closeSSDetail();
    showToast('Captura favorita establecida.');
}


function renderPrivacyServers() {
    const publicContainer = document.getElementById('lista-publica');
    const hiddenContainer = document.getElementById('lista-privada');
    if (!publicContainer || !hiddenContainer) return;

    const publicServers = privacyServerCache.filter(s => !privacyHiddenServerIps.has(s.ip));
    const hiddenServers = privacyServerCache.filter(s => privacyHiddenServerIps.has(s.ip));

    publicContainer.innerHTML = publicServers.length
        ? publicServers.map(s => `<div class="server-item"><span>${escapeHtml(s.name || s.ip || 'Desconocido')}</span><button class="btn-eye" onclick="hidePrivacyServer('${escapeHtml(s.ip || '')}')" title="Ocultar servidor"><i class="fa-solid fa-eye-slash"></i></button></div>`).join('')
        : '<p class="empty-text">No hay servidores públicos detectados.</p>';

    hiddenContainer.innerHTML = hiddenServers.length
        ? hiddenServers.map(s => `<div class="server-item"><span>${escapeHtml(s.name || s.ip || 'Desconocido')}</span><button class="btn-eye" onclick="showPrivacyServer('${escapeHtml(s.ip || '')}')" title="Mostrar servidor"><i class="fa-solid fa-eye"></i></button></div>`).join('')
        : '<p class="empty-text">No hay servidores ocultos.</p>';
}

function hidePrivacyServer(ip) {
    if (!ip) return;
    privacyHiddenServerIps.add(ip);
    savePrivacyHiddenServers();
    renderPrivacyServers();
}

function showPrivacyServer(ip) {
    if (!ip) return;
    privacyHiddenServerIps.delete(ip);
    savePrivacyHiddenServers();
    renderPrivacyServers();
    // Mostrar notificación
    const notif = document.getElementById('notification');
    const notifText = document.getElementById('notif-text');
    if (notif && notifText) {
        notifText.innerHTML = `La IP <b>${ip}</b> se hizo pública. Tus amigos pueden ver en la lista de top servidores la IP del servidor si has entrado varias veces.`;
        notif.classList.add('show');
        setTimeout(() => notif.classList.remove('show'), 6000);
    }
}

function togglePublicServers() {
    const publicContainer = document.getElementById('lista-publica');
    const btn = document.getElementById('btn-toggle-public');
    if (!publicContainer || !btn) return;

    const isVisible = publicContainer.classList.toggle('hidden') === false;
    btn.innerText = isVisible ? 'Ocultar' : 'Mostrar';

    if (isVisible) renderPrivacyServers();
}

function toggleHiddenServers() {
    const hiddenContainer = document.getElementById('lista-privada');
    const btn = document.getElementById('btn-toggle-hidden');
    if (!hiddenContainer || !btn) return;

    const isVisible = hiddenContainer.classList.toggle('hidden') === false;
    btn.innerText = isVisible ? 'Ocultar' : 'Mostrar';

    if (isVisible) renderPrivacyServers();
}

function filtrar() {
    const busqueda = document.getElementById('buscador').value.toLowerCase();
    document.querySelectorAll('.server-item').forEach(item => {
        const ip = item.querySelector('span').innerText.toLowerCase();
        item.style.display = ip.includes(busqueda) ? 'flex' : 'none';
    });
}

function openPrivacyModal() {
    const modal = document.getElementById('privacy-settings-modal');
    if (!modal) return;

    const mainPanel = document.getElementById('main-panel');
    if (mainPanel) {
        mainPanel.style.display = 'none';
    }

    const friendsPanel = document.getElementById('friends-panel');
    if (friendsPanel) {
        friendsPanel.style.display = 'none';
    }

    const privacyContainer = document.getElementById('privacy-settings-modal');
    if (privacyContainer) {
        privacyContainer.classList.remove('hidden');
    }

    updatePrivacyControls();
    loadPrivacyServers();
}

function closePrivacyModal() {
    const modal = document.getElementById('privacy-settings-modal');
    if (!modal) return;

    modal.classList.add('hidden');
    const mainPanel = document.getElementById('main-panel');
    if (mainPanel) {
        mainPanel.style.display = 'block';
    }

    const friendsPanel = document.getElementById('friends-panel');
    if (friendsPanel) {
        friendsPanel.style.display = 'block';
    }
}

function toggleGPU() {
    const gpuBtn = document.getElementById('gpu-toggle');
    if (!gpuBtn) return;

    gpuBtn.classList.toggle('on');
    const isDeactivated = gpuBtn.classList.contains('on');

    localStorage.setItem('disableGPU', isDeactivated ? 'true' : 'false');
    ipc.send('save-gpu-setting', isDeactivated);

    showToast('GPU', 'Cambio guardado. Reinicia el launcher para aplicar.', 'info');
}

function initPrivacyGPUSettings() {
    const savedGPU = localStorage.getItem('disableGPU');
    const gpuBtn = document.getElementById('gpu-toggle');

    const disableGPU = savedGPU === null ? true : (savedGPU !== 'false');

    if (gpuBtn) {
        if (disableGPU) {
            gpuBtn.classList.add('on');
        } else {
            gpuBtn.classList.remove('on');
        }
    }

    ipc.send('save-gpu-setting', disableGPU);
}

// Initialize GPU toggle states when arranca el launcher
window.addEventListener('DOMContentLoaded', () => {
    initPrivacyGPUSettings();
});

function savePrivacySettings() {
    const btnSave = document.querySelector('.btn-primary[onclick="savePrivacySettings()"]');

    if (btnSave) {
        btnSave.disabled = true;
        btnSave.innerText = 'Guardando...';
    }

    savePrivacyHiddenServers();
    saveSecuritySettings();
    updatePrivacyControls();

    const commitDone = () => {
        if (btnSave) {
            btnSave.disabled = false;
            btnSave.innerText = 'Guardar cambio de privacidad';
        }
    };

    const identity = getLinkedIdentity();
    if (identity && firebaseReady && firebaseDb && firebaseFns) {
        const snapshot = getCurrentPresenceSnapshot();
        firebaseFns.update(firebaseFns.ref(firebaseDb, `perfiles/${cleanFriendKey(identity)}`), {
            privacy: {
                shareTopServers: isShareTopServers,
                hideLocalTime: isHideLocalTime,
                hiddenServers: Array.from(privacyHiddenServerIps),
                favCapture: snapshot.favCapture
            },
            updatedAt: Date.now()
        }).then(() => {
            showToast('Privacidad', 'Configuración de privacidad guardada en la base de datos.', 'success');
        }).catch((error) => {
            console.warn('Error al guardar privacidad en Firebase', error);
            showToast('Privacidad', 'No se pudo guardar en Firebase, guardado localmente.', 'warning');
        }).finally(() => {
            commitDone();
            syncPresenceToFirebase();
        });
    } else {
        showToast('Privacidad', 'Configuración guardada localmente. Activa Firebase para sincronizar.', 'info');
        commitDone();
        syncPresenceToFirebase();
    }
}


function normalizeAccount(account = {}) {
    const resolvedName = String(account.username || account.name || '').trim();
    if (!resolvedName) return null;

    return {
        username: resolvedName,
        name: resolvedName,
        type: account.type === 'premium' ? 'premium' : 'offline',
        uuid: account.uuid || null,
        accessToken: account.accessToken || null,
        refreshToken: account.refreshToken || null,
        profile: account.profile || null,
        isFavorite: Boolean(account.isFavorite),
        avatar: account.avatar || getCachedAvatar(resolvedName) || createOfflineAvatar(resolvedName)
    };
}

function normalizeAccountsForStorage(accounts = []) {
    const normalizedAccounts = (Array.isArray(accounts) ? accounts : [])
        .map(normalizeAccount)
        .filter(Boolean);

    if (normalizedAccounts.length === 1) {
        normalizedAccounts[0].isFavorite = true;
        return normalizedAccounts;
    }

    let favoriteFound = false;
    normalizedAccounts.forEach((account) => {
        if (account.isFavorite && !favoriteFound) {
            favoriteFound = true;
        } else {
            account.isFavorite = false;
        }
    });

    return normalizedAccounts;
}

function getStoredAccounts() {
    const rawAccounts = JSON.parse(localStorage.getItem('azureAccounts') || '[]');
    const normalizedAccounts = normalizeAccountsForStorage(rawAccounts);

    if (JSON.stringify(rawAccounts) !== JSON.stringify(normalizedAccounts)) {
        localStorage.setItem('azureAccounts', JSON.stringify(normalizedAccounts));
    }

    return normalizedAccounts;
}

function saveStoredAccounts(accounts) {
    const normalizedAccounts = normalizeAccountsForStorage(accounts);
    localStorage.setItem('azureAccounts', JSON.stringify(normalizedAccounts));
}

function getAutoLoginAccount(accounts = getStoredAccounts()) {
    if (accounts.length === 1) return accounts[0];
    return accounts.find((account) => account.isFavorite) || null;
}

function buildAvatarUrl(name = 'Steve') {
    const safeName = String(name || 'Steve').trim() || 'Steve';
    return `https://minotar.net/helm/${encodeURIComponent(safeName)}/64`;
}

function createOfflineAvatar(name = 'Steve') {
    const safeName = String(name || 'Steve').trim() || 'Steve';
    const glyph = (safeName[0] || 'S').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'S';
    const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
            <defs>
                <linearGradient id="avatarBg" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#0f427e" />
                    <stop offset="100%" stop-color="#081f3a" />
                </linearGradient>
            </defs>
            <rect width="64" height="64" rx="14" fill="url(#avatarBg)" />
            <text x="32" y="39" text-anchor="middle" font-size="28" font-family="Segoe UI, Arial, sans-serif" fill="#ffffff">${glyph}</text>
        </svg>
    `.trim();

    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function getCachedAvatar(name = '') {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    return localStorage.getItem(`azureAvatarCache:${key}`);
}

function persistAvatar(name, avatarDataUrl) {
    const safeName = String(name || '').trim();
    if (!safeName || !avatarDataUrl) return;

    localStorage.setItem(`azureAvatarCache:${safeName.toLowerCase()}`, avatarDataUrl);

    const accounts = getStoredAccounts();
    const accountIndex = accounts.findIndex((acc) => String(acc.name || '').toLowerCase() === safeName.toLowerCase());
    if (accountIndex !== -1) {
        accounts[accountIndex].avatar = avatarDataUrl;
        saveStoredAccounts(accounts);
    }
}

async function fetchAvatarAsDataUrl(url) {
    const response = await fetch(url, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

async function setUserAvatar(name = 'Steve', preferredAvatar = '') {
    const avatarElem = document.getElementById('user-avatar');
    if (!avatarElem) return;

    const safeName = String(name || 'Steve').trim() || 'Steve';
    const offlineAvatar = createOfflineAvatar(safeName);
    const cachedAvatar = (typeof preferredAvatar === 'string' && preferredAvatar.startsWith('data:'))
        ? preferredAvatar
        : getCachedAvatar(safeName);

    avatarElem.onerror = () => {
        avatarElem.onerror = null;
        avatarElem.src = cachedAvatar || offlineAvatar;
    };

    avatarElem.src = cachedAvatar || offlineAvatar;

    if (!navigator.onLine) return;

    const remoteAvatar = (typeof preferredAvatar === 'string' && /^https?:\/\//i.test(preferredAvatar))
        ? preferredAvatar
        : buildAvatarUrl(safeName);

    try {
        const avatarDataUrl = await fetchAvatarAsDataUrl(remoteAvatar);
        persistAvatar(safeName, avatarDataUrl);
        avatarElem.src = avatarDataUrl;
    } catch (error) {
        console.warn(`No se pudo actualizar la skin de ${safeName}:`, error);
    }
}

function actualizarVisualizacionSkin(nombre = 'Steve') {
    const safeName = String(nombre || 'Steve').trim() || 'Steve';
    const bodyImg = document.getElementById('skin-body-preview');
    const nickLabel = document.getElementById('display-nick-skin');
    const bodyImgSettings = document.getElementById('skin-body-preview-settings');
    const nickLabelSettings = document.getElementById('display-nick-skin-settings');

    if (nickLabel) {
        nickLabel.innerText = safeName;
    }
    if (nickLabelSettings) {
        nickLabelSettings.innerText = safeName;
    }

    const updateBodyImage = (imgElem) => {
        if (!imgElem) return;

        const cachedAvatar = getCachedAvatar(safeName);
        if (cachedAvatar && cachedAvatar.startsWith('data:image')) {
            currentSkinDataUrl = cachedAvatar;
            imgElem.src = cachedAvatar;
            return;
        }

        const safeEncodedName = encodeURIComponent(safeName);
        const bodyUrl = `https://minotar.net/armor/body/${safeEncodedName}/150.png`;
        const fallbackBody = 'https://minotar.net/armor/body/Steve/150.png';

        if (!currentSkinDataUrl) {
            currentSkinDataUrl = `https://minotar.net/skin/${safeEncodedName}.png`;
        }

        imgElem.onerror = () => {
            imgElem.onerror = null;
            imgElem.src = fallbackBody;
        };
        imgElem.src = bodyUrl;
    };

    updateBodyImage(bodyImg);
    updateBodyImage(bodyImgSettings);
    renderSkinLibrary();
}

function getSkinLibraryKey(userIdentifier) {
    const safeIdentifier = String(userIdentifier || 'invitado').trim().toLowerCase();
    return `skins_library_${safeIdentifier}`;
}

function getSkinStorageUserKey(account) {
    const key = String(account?.uuid || account?.name || 'invitado').trim().toLowerCase();
    return key.replace(/[^a-z0-9_-]/gi, '_');
}

function dataURLToBlob(dataUrl) {
    const parts = dataUrl.split(',');
    const header = parts[0];
    const raw = atob(parts[1]);
    const mimeMatch = header.match(/data:([^;]+);/i);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    const array = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
        array[i] = raw.charCodeAt(i);
    }
    return new Blob([array], { type: mime });
}

function renderSkinLibrary() {
    const library = document.getElementById('skin-library-list');
    if (!library) return;

    library.innerHTML = skinLibrary.map((item, index) => `
        <div class="skin-card" onclick="selectLibrarySkin(${index})">
            <img src="${item.dataUrl}" alt="Skin ${item.name}" class="skin-card-img">
            <div class="skin-card-info">
                <span class="skin-name">${item.name || 'Skin'}</span>
                <span class="skin-model">${item.model || 'Modelo'}</span>
            </div>
        </div>
    `).join('');
}

function saveSkinToLibrary(skinData, model = 'classic', name = '', userIdentifier = '') {
    const currentUser = String(userIdentifier || localStorage.getItem('last_username') || 'invitado').trim() || 'invitado';
    const storageKey = getSkinLibraryKey(currentUser);
    const skinName = String(name || currentUser || 'Skin').trim() || 'Skin';

    let existingLibrary = JSON.parse(localStorage.getItem(storageKey) || '[]');
    existingLibrary.unshift({
        id: Date.now(),
        name: skinName,
        model,
        dataUrl: skinData
    });
    existingLibrary = existingLibrary.slice(0, 12);

    localStorage.setItem(storageKey, JSON.stringify(existingLibrary));
    skinLibrary = existingLibrary;
    renderSkinLibrary();
    console.log(`Skin guardada para el usuario: ${currentUser}`);
}

async function saveSkinMetadataToFirebase(account, skinDataUrl, skinName, model) {
    if (!firebaseReady || !firebaseDb || !firebaseFns || !window.fbStorage || !window.fbStorageRef || !window.fbUploadBytes || !window.fbGetDownloadURL) {
        return null;
    }

    try {
        const userKey = getSkinStorageUserKey(account);
        const blob = dataURLToBlob(skinDataUrl);
        const fileName = `skins/${userKey}/${Date.now()}_${clean(String(skinName || account?.name || 'skin'))}.png`;
        const storageReference = window.fbStorageRef(window.fbStorage, fileName);

        await window.fbUploadBytes(storageReference, blob, { contentType: blob.type });
        const downloadUrl = await window.fbGetDownloadURL(storageReference);

        const skinRecord = {
            id: Date.now(),
            name: skinName || `Skin ${new Date().toLocaleString()}`,
            model: model || 'classic',
            url: downloadUrl,
            updatedAt: Date.now()
        };

        await firebaseFns.set(firebaseFns.dbRef(firebaseDb, `skins/${userKey}/${skinRecord.id}`), skinRecord);
        await firebaseFns.update(firebaseFns.dbRef(firebaseDb, `usuarios/${userKey}`), {
            activeSkinUrl: downloadUrl,
            activeSkinName: skinRecord.name,
            activeSkinModel: skinRecord.model,
            skinLastSynced: Date.now()
        });

        return downloadUrl;
    } catch (error) {
        console.warn('No se pudo subir la skin a Firebase:', error);
        return null;
    }
}

async function loadRemoteSkinLibrary(account) {
    if (!account || !firebaseReady || !firebaseDb || !firebaseFns) return;

    try {
        const userKey = getSkinStorageUserKey(account);
        const snapshot = await firebaseFns.get(firebaseFns.dbRef(firebaseDb, `skins/${userKey}`));
        if (!snapshot.exists()) return;

        const remoteSkins = Object.values(snapshot.val() || {}).map((item) => ({
            id: item.id || Date.now(),
            name: item.name || 'Skin remota',
            model: item.model || 'classic',
            dataUrl: item.url || ''
        })).filter((item) => item.dataUrl);

        if (remoteSkins.length === 0) return;

        const storageKey = getSkinLibraryKey(account.name);
        const existingLibrary = JSON.parse(localStorage.getItem(storageKey) || '[]');
        const merged = [...remoteSkins, ...existingLibrary]
            .reduce((acc, item) => {
                if (!acc.some((saved) => saved.dataUrl === item.dataUrl)) {
                    acc.push(item);
                }
                return acc;
            }, [])
            .slice(0, 12);

        localStorage.setItem(storageKey, JSON.stringify(merged));
        skinLibrary = merged;
        renderSkinLibrary();
    } catch (error) {
        console.warn('Error cargando skins desde Firebase:', error);
    }
}

function initSkinViewer() {
    if (miVisor3D) return; // ya inicializado

    if (!window.skinview3d) {
        console.log('skinview3d no cargado aún, esperando...');
        setTimeout(initSkinViewer, 500);
        return;
    }

    const initialUsername = currentAccount?.name || 'Steve';
    const cachedAvatar = getCachedAvatar(initialUsername);
    const initialSkin = cachedAvatar || `https://minotar.net/skin/${encodeURIComponent(initialUsername)}.png`;

    currentSkinDataUrl = initialSkin;

    // Inicializar el visor 3D
    renderizarSkin3D(initialSkin);

    // Lógica de botones
    const btnBrowse = document.getElementById('btn-browse');
    const fileInput = document.getElementById('file-input');
    const statusContainer = document.getElementById('step-4-container');
    const statusText = document.getElementById('status-text');

    if (btnBrowse && fileInput) {
        btnBrowse.addEventListener('click', () => fileInput.click());

        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            statusContainer.style.opacity = "1";
            statusText.textContent = "Cargando: " + file.name;

            const reader = new FileReader();

            reader.onprogress = (progressEvent) => {
                if (progressEvent.lengthComputable) {
                    const percent = Math.round((progressEvent.loaded / progressEvent.total) * 100);
                    statusText.textContent = `Cargando ${file.name}... ${percent}%`;
                }
            };

            reader.onloadstart = () => {
                statusText.textContent = `Empezando carga de ${file.name}...`;
            };

            reader.onload = (event) => {
                console.log('Skin cargada:', event.target.result.substring(0, 50) + '...');
                statusText.textContent = `Procesando skin...`;
                const dataUrl = event.target.result;
                currentSkinDataUrl = dataUrl;
                renderizarSkin3D(dataUrl);
                console.log('Skin cargada en visor 3D');
                setUserAvatar(currentAccount?.name || 'Steve', dataUrl);
                actualizarVisualizacionSkin(currentAccount?.name || 'Steve');
                localStorage.setItem('last_skin_url', dataUrl);

                statusText.textContent = `¡Skin cargada! Toca APLICAR para guardar.`;
                statusContainer.style.opacity = "1";
            };

            reader.onerror = () => {
                statusText.textContent = `Error cargando archivo ${file.name}. Intenta de nuevo.`;
                console.error('Error en FileReader');
            };

            reader.onloadend = () => {
                if (!reader.error) {
                    statusText.textContent = `Listo: ${file.name} cargada al visor.`;
                }
            };

            reader.readAsDataURL(file);
        });

    }

    // Cambiar Modelos
    const mClassic = document.getElementById('m-classic');
    const mSlim = document.getElementById('m-slim');

    if (mClassic) {
        mClassic.addEventListener('click', function() {
            this.classList.add('active');
            mSlim.classList.remove('active');
            miVisor3D.playerObject.skin.model = "classic";
        });
    }

    if (mSlim) {
        mSlim.addEventListener('click', function() {
            this.classList.add('active');
            mClassic.classList.remove('active');
            miVisor3D.playerObject.skin.model = "slim";
        });
    }

    // Reiniciar cámara
    const btnReset = document.getElementById('btn-reset-skin');
    if (btnReset) {
        btnReset.addEventListener('click', () => {
            miVisor3D.autoRotate = !miVisor3D.autoRotate;
        });
    }

    // Guardar como skin activa en cuenta
    const btnSave = document.getElementById('btn-save-skin');
    if (btnSave) {
        btnSave.addEventListener('click', () => {
            aplicarSkinEnCuenta();
        });
    }
}

// 1. FUNCIÓN PARA EL MODELO 3D (Cuadro Verde)
window.renderizarSkin3D = function(skinURL) {
    const canvas = document.getElementById('skin-viewer-canvas'); // Asegúrate que este ID esté en tu HTML
    if (!canvas) {
        console.error("No se encontró el canvas para la skin");
        return;
    }

    // Si ya existe un visor, lo limpiamos para no poner lenta la PC
    if (window.miVisor3D) {
        try {
            window.miVisor3D.dispose();
        } catch (e) {
            console.warn('No se pudo disposear miVisor3D:', e);
        }
    }

    // Ajustar tamaño al contenedor (para evitar el canvas invisible)
    const w = Math.max(280, canvas.clientWidth || 280);
    const h = Math.max(400, canvas.clientHeight || 400);
    canvas.width = w;
    canvas.height = h;

    // Creamos el modelo 3D
    window.miVisor3D = new skinview3d.SkinViewer({
        canvas: canvas,
        width: w,
        height: h,
        skin: skinURL
    });

    // Animación de caminata
    window.miVisor3D.animation = new skinview3d.WalkingAnimation();
    window.miVisor3D.animation.speed = 0.6;

    // Control de rotación con el mouse
    if (window.miVisor3D.controls) {
        window.miVisor3D.controls.enableRotate = true;
        window.miVisor3D.controls.enableZoom = false;
    }
};

function selectLibrarySkin(index) {
    const selected = skinLibrary[index];
    if (!selected || !selected.dataUrl) return;

    currentSkinDataUrl = selected.dataUrl;
    setUserAvatar(currentAccount?.name || 'Steve', selected.dataUrl);
    actualizarVisualizacionSkin(currentAccount?.name || 'Steve');
    if (miVisor3D) {
        miVisor3D.loadSkin(selected.dataUrl);
    }
    showToast('Skin cargada desde la librería.');
}


function restablecerSkinPredeterminada() {
    if (!currentAccount) {
        showToast('Selecciona primero una cuenta.');
        return;
    }
    const safeName = String(currentAccount.name || 'Steve').trim().toLowerCase();
    localStorage.removeItem(`azureAvatarCache:${safeName}`);
    setUserAvatar('Steve');
    actualizarVisualizacionSkin('Steve');
    currentSkinDataUrl = null;
    if (miVisor3D) {
        miVisor3D.loadSkin('https://minotar.net/skin/Steve.png');
    }
    showToast('Skin restablecida a la predeterminada.');
}

function openSkinFileDialog() {
    if (!currentAccount) {
        const accounts = getStoredAccounts();
        const autoLoginAccount = getAutoLoginAccount(accounts) || accounts[0] || null;
        if (autoLoginAccount) {
            selectAccount(autoLoginAccount, { closeModal: false, updateList: true });
            showScreen('screen-dashboard');
            showSection('play');
        } else {
            showToast('Selecciona o crea una cuenta antes de subir una skin.');
            return;
        }
    }

    initSkinViewer();
    document.getElementById("file-input").click();
}

function setClassicModel() {
    document.getElementById('m-classic')?.classList.add('active');
    document.getElementById('m-slim')?.classList.remove('active');
    if (miVisor3D) {
        miVisor3D.playerObject.skin.model = 'classic';
    }
}

function setSlimModel() {
    document.getElementById('m-slim')?.classList.add('active');
    document.getElementById('m-classic')?.classList.remove('active');
    if (miVisor3D) {
        miVisor3D.playerObject.skin.model = 'slim';
    }
}

function resetSkinView() {
    skinViewer.controls.reset();
}

function applySkin() {
    if (!currentAccount) {
        const accounts = getStoredAccounts();
        const autoLoginAccount = getAutoLoginAccount(accounts) || accounts[0] || null;
        if (autoLoginAccount) {
            selectAccount(autoLoginAccount, { closeModal: false, updateList: true });
            showScreen('screen-dashboard');
            showSection('play');
        }
    }
    aplicarSkinEnCuenta();
}

function aplicarSkinEnCuenta() {
    if (!currentAccount) {
        showToast('Selecciona primero una cuenta.');
        return;
    }
    if (!currentSkinDataUrl) {
        showToast('No hay skin cargada. Sube una skin desde "Seleccionar Skin" o elige de la librería.');
        return;
    }

    const skinName = document.getElementById('skin-name')?.value.trim() || `Skin de ${currentAccount.name}`;
    const skinModel = currentModel;

    persistAvatar(currentAccount.name, currentSkinDataUrl);
    setUserAvatar(currentAccount.name, currentSkinDataUrl);
    actualizarVisualizacionSkin(currentAccount.name);
    localStorage.setItem('last_skin_url', currentSkinDataUrl);
    if (skinViewer) {
        skinViewer.loadSkin(currentSkinDataUrl);
    }

    const statusText = document.getElementById('status-text');
    if (statusText) {
        statusText.textContent = '¡Skin guardada en tu cuenta!';
    }

    saveSkinToLibrary(currentSkinDataUrl, skinModel, skinName, currentAccount.name);

    // Upload to Firebase if file is selected
    if (currentSkinFile) {
        uploadSkin(currentAccount.uuid || currentAccount.name)
            .then((url) => {
                showToast('Skin subida a Firebase y guardada localmente.');
            })
            .catch((err) => {
                console.error('Error uploading to Firebase:', err);
                showToast('Skin guardada localmente. Error al subir a Firebase.');
            });
    } else {
        showToast('Skin aplicada y guardada en tu cuenta.');
    }
}

function aplicarCapeEnCuenta() {
    if (!currentAccount) {
        showToast('Selecciona primero una cuenta.');
        return;
    }
    if (!currentCapeFile) {
        showToast('No hay cape cargada. Sube una cape desde "Seleccionar Cape".');
        return;
    }

    // Upload to Firebase
    uploadCape(currentAccount.uuid || currentAccount.name)
        .then((url) => {
            showToast('Cape subida a Firebase y aplicada.');
        })
        .catch((err) => {
            console.error('Error uploading cape to Firebase:', err);
            showToast('Error al subir cape a Firebase.');
        });
}

window.manejarSubidaDeSkin = function(event) {
    const archivo = event.target.files?.[0];
    if (!archivo) return;

    currentSkinFile = archivo;

    const lector = new FileReader();
    lector.onload = (e) => {
        const urlImagen = e.target.result;

        console.log('Skin cargada localmente, renderizando 3D...');
        if (typeof window.renderizarSkin3D === 'function') {
            window.renderizarSkin3D(urlImagen);
        }

        window.skinTemporalParaAplicar = urlImagen;
        currentSkinDataUrl = urlImagen;

        const statusText = document.getElementById('status-text');
        if (statusText) {
            statusText.textContent = 'Skin cargada localmente. Presiona APLICAR para guardar.';
        }
    };

    lector.readAsDataURL(archivo);
};

async function exportarSkinUsuario() {
    const name = currentAccount?.name || 'Steve';
    const skinUrl = `https://minotar.net/skin/${encodeURIComponent(name)}.png`;

    try {
        showToast(`Preparando skin de ${name}...`);

        const response = await fetch(skinUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const blob = await response.blob();
        const reader = new FileReader();

        reader.onloadend = async () => {
            const base64data = reader.result;
            const success = await ipc.invoke('export-skin', {
                imageData: base64data,
                username: name
            });

            if (success) {
                showToast('¡Skin guardada en tu PC con éxito!');
            } else {
                showToast('Exportación cancelada.');
            }
        };

        reader.readAsDataURL(blob);
    } catch (error) {
        console.error('Error al exportar skin:', error);
        showToast('Error al obtener la skin del servidor.');
    }
}

function guessCountryOffline() {
    const localeCandidates = [
        localStorage.getItem('launcherLang'),
        localStorage.getItem('azureLanguage'),
        navigator.language,
        Intl.DateTimeFormat().resolvedOptions().locale
    ].filter(Boolean);

    const localeWithRegion = localeCandidates.find((value) => /[-_][A-Za-z]{2}\b/.test(value));
    const region = localeWithRegion
        ? localeWithRegion.split(/[-_]/).pop().toUpperCase()
        : null;

    const regionNames = typeof Intl.DisplayNames === 'function'
        ? new Intl.DisplayNames([getCurrentLanguage()], { type: 'region' })
        : null;

    if (region && regionNames) {
        return regionNames.of(region) || t('offline');
    }

    const lang = String(getCurrentLanguage() || navigator.language || 'es')
        .slice(0, 2)
        .toLowerCase();

    const fallbackByLang = {
        es: 'España',
        en: 'United States',
        pt: 'Brasil',
        fr: 'France'
    };

    return fallbackByLang[lang] || t('offline');
}


// Controles de ventana (requiere Electron)


// --- NUEVA LÓGICA DE PALETA Y AJUSTES ---
let tempSelectedHex = '';
let tempSelectedName = '';

function selectPaletteColor(name, hex, event) {
    tempSelectedHex = hex;
    tempSelectedName = name;

    const selectedLabel = document.getElementById('selected-color-name');
    const actionBar = document.getElementById('palette-action-bar');

    if (selectedLabel) {
        selectedLabel.innerText = `Vista previa: ${name} (${hex})`;
    }

    if (actionBar) {
        actionBar.classList.remove('hidden');
    }

    document.querySelectorAll('.palette-item').forEach(item => item.classList.remove('active'));
    if (event && event.currentTarget) event.currentTarget.classList.add('active');

    setLauncherAccent(hex);
}

function applyPaletteColor() {
    if (!tempSelectedHex) return;

    setLauncherAccent(tempSelectedHex);
    localStorage.setItem('themeColor', tempSelectedHex);
    localStorage.setItem('azureAccentColor', tempSelectedHex);
    localStorage.setItem('launcher-accent', tempSelectedHex);
    showToast(`Color aplicado: ${tempSelectedName || tempSelectedHex}`);
}

// --- SISTEMA DE IDIOMAS ---
const translations = {
    es: {
        welcome: '¡Bienvenido a Azure Launcher!',
        welcomeUser: '¡Bienvenido {name} a Azure Launcher!',
        loginTitle: 'INICIAR SESIÓN',
        premiumTitle: 'Premium',
        premiumDesc: 'Cuenta Microsoft',
        premiumNotAvailableTitle: 'Login Premium no implementado aún.',
        premiumNotAvailableDesc: 'Usa offline para pruebas.',
        offlineTitle: 'No Premium',
        offlineDesc: 'Acceso local / offline',
        offlinePrompt: 'Introduce un nombre de usuario',
        usernamePlaceholder: 'Nombre de usuario',
        access: 'Acceder',
        back: 'Volver',
        installedVersions: 'VERSIONES INSTALADAS',
        versionsEmpty: 'No hay versiones. Haz clic en "+" para agregar.',
        selectedVersion: 'VERSIÓN SELECCIONADA:',
        playNow: '¡JUGAR AHORA!',
        playTab: 'Skin',
        screenshotsTab: 'Capturas',
        serversTab: 'Servidores',
        friendsTab: 'Amigos',
        settingsTab: 'Ajustes',
        readyTitle: 'Listo para la aventura',
        readyDesc: 'Selecciona una versión y presiona el botón JUGAR para comenzar.',
        customizeTitle: 'Personalización de Interfaz',
        paletteDesc: 'Haz clic en un color para ver una previsualización y luego guardarlo:',
        saveColor: 'Guardar color',
        languageRegionTitle: 'Idioma y Región',
        languageHeroTitle: 'Personaliza el idioma del launcher',
        languageHeroDesc: 'Los botones, pestañas y mensajes cambian al instante.',
        activeLanguage: 'Idioma activo',
        detectedCountry: 'País detectado',
        connectionStatus: 'Estado',
        online: 'En línea',
        offline: 'Sin conexión',
        applyLanguageBtn: 'Aplicar idioma',
        gettingCountry: 'Obteniendo...',
        unknown: 'Desconocido',
        notAvailable: 'No disponible',
        screenshotsTitle: 'Capturas',
        screenshotsTip: 'Haz clic en una miniatura para ver la captura y copiar la imagen.',
        copyImage: 'Copiar imagen al portapapeles',
        deleteAccountTitle: '¿Eliminar esta cuenta?',
        deleteAccountDesc: 'Esta acción no se puede deshacer.',
        cancel: 'Cancelar',
        accept: 'Aceptar',
        editModeTitle: 'Modo edición: eliminar cuentas',
        noAccounts: 'No hay cuentas.',
        accountSelectorTitle: '¿QUIÉN ESTÁ JUGANDO?',
        addAccountLabel: 'Añadir cuenta',
        premiumMicrosoft: 'Premium (Microsoft)',
        offlineAccountLabel: 'Cuenta Offline',
        deleteAction: 'Eliminar',
        favoriteSet: 'Cuenta marcada como favorita',
        favoriteRemoved: 'Favorita eliminada',
        singleAccountFavorite: 'Tu única cuenta seguirá siendo la favorita',
        noOfflineAccounts: 'No hay cuentas No Premium guardadas.<br>Escribe un nombre abajo para crear una.',
        friendsLinkTitle: 'Vincular con Discord',
        friendsLinkDesc: '¿Deseas vincular tu nick de Minecraft con Discord para poder tener a tus amigos aquí?',
        chooseMinecraftAccount: 'Selecciona tu cuenta',
        linkDiscordBtn: 'Sí, vincular',
        linkSuccess: '¡Vinculación Exitosa!',
        linkSuccessDesc: 'Ahora tu cuenta de Minecraft está vinculada con Discord.',
        finishLink: 'LISTO',
        linkedAs: 'Vinculado como',
        sendRequest: 'Enviar solicitud',
        acceptRequest: 'Aceptar',
        rejectRequest: 'Rechazar',
        noRequests: 'No tienes solicitudes pendientes.',
        noFriends: 'Aún no hay amigos agregados.',
        friendsPromptTitle: 'Azure Friends',
        friendsPromptDesc: 'Vincula tu cuenta de Discord para ver y gestionar amigos desde el launcher.',
        pendingRequestsTitle: 'Solicitudes pendientes',
        friendTagPlaceholder: 'Nick#7600',
        friendInvalidTag: 'Usa el formato Nick#7600',
        friendAlreadyExists: 'Ese amigo ya está en tu lista o en pendientes',
        friendSelfAdd: 'No puedes agregarte a ti mismo',
        friendRequestSent: 'Solicitud enviada',
        unlinkDiscordBtn: 'Desvincular cuenta',
        unlinkTitle: 'Desvincular esta cuenta',
        unlinkConfirm: 'Se borrará tu lista de amigos, historial y nadie podrá encontrarte en Azure Launcher. Esta acción no se puede deshacer.',
        unlinkSuccess: 'Cuenta de Discord desvinculada'
    },
    en: {
        welcome: 'Welcome to Azure Launcher!',
        welcomeUser: 'Welcome {name} to Azure Launcher!',
        loginTitle: 'SIGN IN',
        premiumTitle: 'Premium',
        premiumDesc: 'Microsoft account',
        premiumNotAvailable: 'Premium login is not implemented yet. Use offline for testing.',
        offlineTitle: 'Offline',
        offlineDesc: 'Local / offline access',
        offlinePrompt: 'Enter a username',
        usernamePlaceholder: 'Username',
        access: 'Access',
        back: 'Back',
        installedVersions: 'INSTALLED VERSIONS',
        versionsEmpty: 'There are no versions yet. Click "+" to add one.',
        selectedVersion: 'SELECTED VERSION:',
        playNow: 'PLAY NOW!',
        playTab: 'Play',
        screenshotsTab: 'Screenshots',
        serversTab: 'Servers',
        friendsTab: 'Friends',
        settingsTab: 'Settings',
        readyTitle: 'Ready for the adventure',
        readyDesc: 'Select a version and press PLAY to begin.',
        customizeTitle: 'Interface Customization',
        paletteDesc: 'Click a color for a preview and then save it:',
        saveColor: 'Save color',
        languageRegionTitle: 'Language & Region',
        languageHeroTitle: 'Customize the launcher language',
        languageHeroDesc: 'Buttons, tabs, and messages change instantly.',
        activeLanguage: 'Active language',
        detectedCountry: 'Detected country',
        connectionStatus: 'Status',
        online: 'Online',
        offline: 'Offline',
        applyLanguageBtn: 'Apply language',
        gettingCountry: 'Fetching...',
        unknown: 'Unknown',
        notAvailable: 'Not available',
        screenshotsTitle: 'Screenshots',
        screenshotsTip: 'Click a thumbnail to preview the screenshot and copy it.',
        copyImage: 'Copy image to clipboard',
        deleteAccountTitle: 'Delete this account?',
        deleteAccountDesc: 'This action cannot be undone.',
        cancel: 'Cancel',
        accept: 'Accept',
        editModeTitle: 'Edit mode: remove accounts',
        noAccounts: 'No accounts yet.',
        accountSelectorTitle: "WHO'S PLAYING?",
        addAccountLabel: 'Add account',
        premiumMicrosoft: 'Premium (Microsoft)',
        offlineAccountLabel: 'Offline account',
        deleteAction: 'Delete',
        favoriteSet: 'Account set as favorite',
        favoriteRemoved: 'Favorite removed',
        singleAccountFavorite: 'Your only account will remain the favorite',
        noOfflineAccounts: 'No offline accounts saved yet.<br>Type a name below to create one.',
        friendsLinkTitle: 'Link with Discord',
        friendsLinkDesc: 'Do you want to link your Minecraft nickname with Discord so you can see your friends here?',
        chooseMinecraftAccount: 'Choose your account',
        linkDiscordBtn: 'Yes, link it',
        linkSuccess: 'Link successful!',
        linkSuccessDesc: 'Your Minecraft account is now linked with Discord.',
        finishLink: 'DONE',
        linkedAs: 'Linked as',
        sendRequest: 'Send request',
        acceptRequest: 'Accept',
        rejectRequest: 'Reject',
        noRequests: 'You have no pending requests.',
        noFriends: 'No friends added yet.',
        friendsPromptTitle: 'Azure Friends',
        friendsPromptDesc: 'Link your Discord account to view and manage friends from the launcher.',
        pendingRequestsTitle: 'Pending requests',
        friendTagPlaceholder: 'Nick#7600',
        friendInvalidTag: 'Use the format Nick#7600',
        friendAlreadyExists: 'That friend is already on your list or pending',
        friendSelfAdd: 'You cannot add yourself',
        friendRequestSent: 'Request sent',
        unlinkDiscordBtn: 'Unlink account',
        unlinkConfirm: 'Are you sure? Your friend list and history will be removed, and nobody will be able to find you in Azure Launcher. This action cannot be undone.',
        unlinkSuccess: 'Discord account unlinked'
    },
    pt: {
        welcome: 'Bem-vindo ao Azure Launcher!',
        welcomeUser: 'Bem-vindo {name} ao Azure Launcher!',
        loginTitle: 'INICIAR SESSÃO',
        premiumTitle: 'Premium',
        premiumDesc: 'Conta Microsoft',
        premiumNotAvailable: 'Login Premium não implementado ainda. Use offline para testes.',
        offlineTitle: 'Sem Premium',
        offlineDesc: 'Acesso local / offline',
        offlinePrompt: 'Digite um nome de usuário',
        usernamePlaceholder: 'Nome de usuário',
        access: 'Entrar',
        back: 'Voltar',
        installedVersions: 'VERSÕES INSTALADAS',
        versionsEmpty: 'Ainda não há versões. Clique em "+" para adicionar.',
        selectedVersion: 'VERSÃO SELECIONADA:',
        playNow: 'JOGAR AGORA!',
        playTab: 'Jogar',
        screenshotsTab: 'Capturas',
        serversTab: 'Servidores',
        friendsTab: 'Amigos',
        settingsTab: 'Configurações',
        readyTitle: 'Pronto para a aventura',
        readyDesc: 'Selecione uma versão e pressione JOGAR para começar.',
        customizeTitle: 'Personalização da Interface',
        paletteDesc: 'Clique em uma cor para pré-visualizar e depois salvar:',
        saveColor: 'Salvar cor',
        languageRegionTitle: 'Idioma e Região',
        languageHeroTitle: 'Personalize o idioma do launcher',
        languageHeroDesc: 'Botões, abas e mensagens mudam na hora.',
        activeLanguage: 'Idioma ativo',
        detectedCountry: 'País detectado',
        connectionStatus: 'Estado',
        online: 'Online',
        offline: 'Sem conexão',
        applyLanguageBtn: 'Aplicar idioma',
        gettingCountry: 'Obtendo...',
        unknown: 'Desconhecido',
        notAvailable: 'Indisponível',
        screenshotsTitle: 'Capturas',
        screenshotsTip: 'Clique em uma miniatura para ver a captura e copiá-la.',
        copyImage: 'Copiar imagem para a área de transferência',
        deleteAccountTitle: 'Excluir esta conta?',
        deleteAccountDesc: 'Esta ação não pode ser desfeita.',
        cancel: 'Cancelar',
        accept: 'Aceitar',
        editModeTitle: 'Modo de edição: remover contas',
        noAccounts: 'Não há contas.',
        accountSelectorTitle: 'QUEM ESTÁ JOGANDO?',
        addAccountLabel: 'Adicionar conta',
        premiumMicrosoft: 'Premium (Microsoft)',
        offlineAccountLabel: 'Conta Offline',
        deleteAction: 'Excluir',
        favoriteSet: 'Conta marcada como favorita',
        favoriteRemoved: 'Favorita removida',
        singleAccountFavorite: 'Sua única conta continuará como favorita',
        noOfflineAccounts: 'Não há contas Offline salvas.<br>Digite um nome abaixo para criar uma.',
        friendsLinkTitle: 'Vincular com Discord',
        friendsLinkDesc: 'Deseja vincular seu nick do Minecraft ao Discord para ver seus amigos aqui?',
        chooseMinecraftAccount: 'Selecione sua conta',
        linkDiscordBtn: 'Sim, vincular',
        linkSuccess: 'Vinculação concluída!',
        linkSuccessDesc: 'Sua conta do Minecraft agora está vinculada ao Discord.',
        finishLink: 'PRONTO',
        linkedAs: 'Vinculado como',
        sendRequest: 'Enviar solicitação',
        acceptRequest: 'Aceitar',
        rejectRequest: 'Recusar',
        noRequests: 'Você não tem solicitações pendentes.',
        noFriends: 'Nenhum amigo adicionado ainda.',
        friendsPromptTitle: 'Azure Friends',
        friendsPromptDesc: 'Vincule sua conta do Discord para ver e gerenciar amigos pelo launcher.',
        pendingRequestsTitle: 'Solicitações pendentes',
        friendTagPlaceholder: 'Nick#7600',
        friendInvalidTag: 'Use o formato Nick#7600',
        friendAlreadyExists: 'Esse amigo já está na lista ou pendente',
        friendSelfAdd: 'Você não pode adicionar a si mesmo',
        friendRequestSent: 'Solicitação enviada',
        unlinkDiscordBtn: 'Desvincular conta',
        unlinkConfirm: 'Tem certeza? Sua lista de amigos e histórico serão apagados, e ninguém poderá encontrá-lo no Azure Launcher. Esta ação não pode ser desfeita.',
        unlinkSuccess: 'Conta do Discord desvinculada'
    },
    fr: {
        welcome: 'Bienvenue sur Azure Launcher !',
        welcomeUser: 'Bienvenue {name} sur Azure Launcher !',
        loginTitle: 'SE CONNECTER',
        premiumTitle: 'Premium',
        premiumDesc: 'Compte Microsoft',
        premiumNotAvailable: 'Connexion Premium non implémentée pour l’instant. Utilisez le mode hors ligne pour les tests.',
        offlineTitle: 'Hors ligne',
        offlineDesc: 'Accès local / hors ligne',
        offlinePrompt: 'Entrez un nom d’utilisateur',
        usernamePlaceholder: 'Nom d’utilisateur',
        access: 'Accéder',
        back: 'Retour',
        installedVersions: 'VERSIONS INSTALLÉES',
        versionsEmpty: 'Aucune version. Cliquez sur "+" pour en ajouter une.',
        selectedVersion: 'VERSION SÉLECTIONNÉE :',
        playNow: 'JOUER MAINTENANT !',
        playTab: 'Jouer',
        screenshotsTab: 'Captures',
        serversTab: 'Serveurs',
        friendsTab: 'Amis',
        settingsTab: 'Paramètres',
        readyTitle: 'Prêt pour l’aventure',
        readyDesc: 'Sélectionnez une version puis appuyez sur JOUER pour commencer.',
        customizeTitle: 'Personnalisation de l’interface',
        paletteDesc: 'Cliquez sur une couleur pour l’aperçu puis enregistrez-la :',
        saveColor: 'Enregistrer la couleur',
        languageRegionTitle: 'Langue et région',
        languageHeroTitle: 'Personnalisez la langue du launcher',
        languageHeroDesc: 'Les boutons, onglets et messages changent instantanément.',
        activeLanguage: 'Langue active',
        detectedCountry: 'Pays détecté',
        connectionStatus: 'État',
        online: 'En ligne',
        offline: 'Hors ligne',
        applyLanguageBtn: 'Appliquer la langue',
        gettingCountry: 'Chargement...',
        unknown: 'Inconnu',
        notAvailable: 'Indisponible',
        screenshotsTitle: 'Captures',
        screenshotsTip: 'Cliquez sur une miniature pour voir la capture et la copier.',
        copyImage: 'Copier l’image dans le presse-papiers',
        deleteAccountTitle: 'Supprimer ce compte ?',
        deleteAccountDesc: 'Cette action est irréversible.',
        cancel: 'Annuler',
        accept: 'Accepter',
        editModeTitle: 'Mode édition : supprimer des comptes',
        noAccounts: 'Aucun compte.',
        accountSelectorTitle: 'QUI JOUE ?',
        addAccountLabel: 'Ajouter un compte',
        premiumMicrosoft: 'Premium (Microsoft)',
        offlineAccountLabel: 'Compte hors ligne',
        deleteAction: 'Supprimer',
        favoriteSet: 'Compte défini comme favori',
        favoriteRemoved: 'Favori supprimé',
        singleAccountFavorite: 'Votre seul compte restera favori',
        noOfflineAccounts: 'Aucun compte hors ligne enregistré.<br>Saisissez un nom ci-dessous pour en créer un.',
        friendsLinkTitle: 'Lier avec Discord',
        friendsLinkDesc: 'Souhaitez-vous lier votre pseudo Minecraft à Discord pour voir vos amis ici ?',
        chooseMinecraftAccount: 'Choisissez votre compte',
        linkDiscordBtn: 'Oui, lier',
        linkSuccess: 'Liaison réussie !',
        linkSuccessDesc: 'Votre compte Minecraft est maintenant lié à Discord.',
        finishLink: 'TERMINER',
        linkedAs: 'Lié comme',
        sendRequest: 'Envoyer une demande',
        acceptRequest: 'Accepter',
        rejectRequest: 'Refuser',
        noRequests: 'Aucune demande en attente.',
        noFriends: 'Aucun ami ajouté pour le moment.',
        friendsPromptTitle: 'Azure Friends',
        friendsPromptDesc: 'Liez votre compte Discord pour voir et gérer vos amis depuis le launcher.',
        pendingRequestsTitle: 'Demandes en attente',
        friendTagPlaceholder: 'Nick#7600',
        friendInvalidTag: 'Utilisez le format Nick#7600',
        friendAlreadyExists: 'Cet ami est déjà dans votre liste ou en attente',
        friendSelfAdd: 'Vous ne pouvez pas vous ajouter vous-même',
        friendRequestSent: 'Demande envoyée',
        unlinkDiscordBtn: 'Délier le compte',
        unlinkConfirm: 'Êtes-vous sûr ? Votre liste d’amis et votre historique seront supprimés, et personne ne pourra vous retrouver dans Azure Launcher. Cette action est irréversible.',
        unlinkSuccess: 'Compte Discord délié'
    }
};

const languageLabels = {
    es: 'Español',
    en: 'English',
    pt: 'Português',
    fr: 'Français'
};

function getCurrentLanguage() {
    return localStorage.getItem('launcherLang') || localStorage.getItem('azureLanguage') || 'es';
}

function t(key, lang = getCurrentLanguage()) {
    return translations[lang]?.[key] || translations.es[key] || key;
}

function updateWelcomeMessage(name = '') {
    const welcomeElem = document.getElementById('welcome-msg');
    if (!welcomeElem) return;

    const safeName = String(name || '').trim();
    const defaultNames = ['usuario', 'user'];
    const hasCustomName = safeName && !defaultNames.includes(safeName.toLowerCase());

    welcomeElem.innerText = hasCustomName
        ? t('welcomeUser').replace('{name}', safeName)
        : t('welcome');
}

function updateLanguageRegionPreview(lang = getCurrentLanguage()) {
    const selectedLanguagePreview = document.getElementById('selected-language-preview');
    if (selectedLanguagePreview) {
        selectedLanguagePreview.innerText = languageLabels[lang] || languageLabels.es;
    }

    const connectionStatusPreview = document.getElementById('connection-status-preview');
    if (connectionStatusPreview) {
        connectionStatusPreview.innerText = navigator.onLine ? t('online', lang) : t('offline', lang);
    }

    const countryPreview = document.getElementById('region-country-preview');
    const liveCountryText = document.getElementById('country-text')?.innerText?.trim();
    const fallbackCountry = localStorage.getItem(COUNTRY_CACHE_KEY) || guessCountryOffline() || t('gettingCountry', lang);

    if (countryPreview) {
        countryPreview.innerText = liveCountryText && liveCountryText !== t('gettingCountry', lang)
            ? liveCountryText
            : fallbackCountry;
    }
}

function applyTranslations(lang = getCurrentLanguage()) {
    document.documentElement.lang = lang;

    document.querySelectorAll('[data-i18n]').forEach((element) => {
        const key = element.dataset.i18n;
        if (key) {
            element.textContent = t(key, lang);
        }
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
        const key = element.dataset.i18nPlaceholder;
        if (key) {
            element.placeholder = t(key, lang);
        }
    });

    const selector = document.getElementById('language-select-new');
    if (selector) selector.value = lang;

    updateWelcomeMessage(document.getElementById('user-name')?.innerText || '');
    updateLanguageRegionPreview(lang);

    if (typeof renderAccountSelector === 'function') renderAccountSelector();
    if (typeof renderAccountList === 'function') renderAccountList();
    if (typeof renderLoginAccounts === 'function') renderLoginAccounts();
    if (typeof renderAccountEditList === 'function') renderAccountEditList();
    if (typeof renderFriendsPanel === 'function') renderFriendsPanel();
}

// --- Cargar ajustes guardados al abrir ---
window.addEventListener('DOMContentLoaded', () => {
    try {
        const savedColor = localStorage.getItem('azureAccentColor')
            || localStorage.getItem('themeColor')
            || localStorage.getItem('launcher-accent');

        if (savedColor) {
            setLauncherAccent(savedColor);
            document.querySelectorAll('.palette-item').forEach(item => {
                if (item.style.getPropertyValue('--color').trim().toLowerCase() === savedColor.trim().toLowerCase()) {
                    item.classList.add('active');
                    const selectedLabel = document.getElementById('selected-color-name');
                    const actionBar = document.getElementById('palette-action-bar');
                    if (selectedLabel) selectedLabel.innerText = `Color guardado: ${item.innerText}`;
                    if (actionBar) actionBar.classList.remove('hidden');
                }
            });
        }

        const savedLang = getCurrentLanguage();
        const languageSelector = document.getElementById('language-select-new');
        if (languageSelector) {
            languageSelector.value = savedLang;
        }
        applyTranslations(savedLang);

        loadStatusBar();
        loadAccounts();
        if (currentAccount) {
            actualizarVisualizacionSkin(currentAccount.name);
            loadCurrentAccountSkin();
        }
        loadVersionList();
        loadInstalledVersions();
        updateDiscordStatus('En el menú');
        startFriendsRealtimeSync();
        actualizarTopUI();
        escucharTransferencias();
        initSkinViewer();

        // Auto-login immediately to prevent login prompts in skin section
        try {
            const accounts = getStoredAccounts();
            const autoLoginAccount = getAutoLoginAccount(accounts);

            if (autoLoginAccount) {
                selectAccount(autoLoginAccount, { closeModal: false, updateList: true });
                showScreen('screen-dashboard');
                showSection('play');
            } else if (accounts.length > 0) {
                renderAccountSelector();
                showScreen('screen-account-selector');
            } else {
                showScreen('screen-login-choice');
            }
        } catch (startupError) {
            console.error('Error en selección de pantalla inicial:', startupError);
            safeStartupFallback();
        }
    } catch (startupError) {
        console.error('Error durante el arranque del renderer:', startupError);
        safeStartupFallback();
    }
});


// --- Toast notifications ---
function showToast(msg) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.style.position = 'fixed';
        container.style.bottom = '30px';
        container.style.right = '30px';
        container.style.zIndex = '9999';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.style.borderLeft = `4px solid var(--accent-blue)`;
    toast.style.background = 'rgba(0,0,0,0.85)';
    toast.style.color = '#fff';
    toast.style.padding = '12px 22px';
    toast.style.marginTop = '10px';
    toast.style.borderRadius = '7px';
    toast.style.boxShadow = '0 2px 12px rgba(0,0,0,0.18)';
    toast.innerText = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function applyLanguage() {
    const lang = document.getElementById('language-selector').value;
    localStorage.setItem('launcher-lang', lang);
    showToast("Idioma guardado. Reinicia para ver cambios completos.");
}

window.onload = () => {
    const savedColor = localStorage.getItem('launcher-accent');
    if(savedColor) {
        document.documentElement.style.setProperty('--accent-color', savedColor);
    }
};

function showToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerText = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function showScreen(id) {
    document.querySelectorAll('.screen').forEach((screen) => screen.classList.remove('active'));

    const targetScreen = document.getElementById(id);
    if (targetScreen) {
        targetScreen.classList.add('active');
    }

    if (id === 'screen-account-selector') {
        renderAccountSelector();
    }

    if (id === 'screen-offline-login') {
        renderLoginAccounts();
    }
}

function safeStartupFallback() {
    try {
        showScreen('screen-login-choice');
    } catch (e) {
        console.error('safeStartupFallback showScreen failed:', e);
    }
    const splashScreen = document.getElementById('screen-splash');
    if (splashScreen) {
        splashScreen.classList.remove('active');
    }
}

window.addEventListener('error', (event) => {
    console.error('Unhandled renderer error:', event.error || event.message || event);
    safeStartupFallback();
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason || event);
    safeStartupFallback();
});

// Carga idioma guardado
const savedLanguage = localStorage.getItem('azureLanguage');
if (savedLanguage) {
    const langSelect = document.getElementById('language-select');
    if (langSelect) langSelect.value = savedLanguage;
}

function loadAccounts() {
    const accounts = getStoredAccounts();
    const select = document.getElementById('account-select');

    if (select) {
        if (accounts.length === 0) {
            select.innerHTML = '<option value="">Sin cuentas</option>';
            select.disabled = true;
        } else {
            select.disabled = false;
            select.innerHTML = accounts.map((acc, index) => `
                <option value="${index}">${acc.name}${acc.isFavorite ? ' ⭐' : ''}</option>
            `).join('');
        }
    }

    renderAccountList();
    renderLoginAccounts();
    renderAccountSelector();
    renderAccountEditList();

    if (currentAccount) {
        const persistedIndex = accounts.findIndex((acc) => acc.name.toLowerCase() === currentAccount.name.toLowerCase());
        if (persistedIndex !== -1) {
            if (select) select.value = String(persistedIndex);
            selectAccount(accounts[persistedIndex], { closeModal: false, updateList: true });
            return;
        }
    }

    currentAccount = null;
    if (select && accounts.length > 0) {
        const preferredIndex = accounts.findIndex((acc) => acc.isFavorite);
        select.value = String(preferredIndex !== -1 ? preferredIndex : 0);
    }

    const userName = document.getElementById('user-name');
    if (userName) userName.innerText = 'Usuario';
    setUserAvatar('Steve');
    updateWelcomeMessage();
}

function renderAccountEditList() {
    const editList = document.getElementById('account-edit-list');
    if (!editList) return;

    const accounts = getStoredAccounts();

    if (accounts.length === 0) {
        editList.innerHTML = `<p class="empty-text">${t('noAccounts')}</p>`;
        return;
    }

    editList.innerHTML = accounts.map((acc, index) => `
        <div class="account-edit-row">
            <span class="account-edit-name">${acc.name}</span>
            <div class="account-edit-actions">
                <button
                    class="account-edit-fav ${acc.isFavorite ? 'favorite' : ''}"
                    onclick="toggleFavoriteByIndex(${index}, event)"
                    title="${acc.isFavorite ? t('favoriteRemoved') : t('favoriteSet')}"
                >
                    <i class="fa-${acc.isFavorite ? 'solid' : 'regular'} fa-star"></i>
                </button>
                <button class="account-edit-btn" onclick="openDeleteConfirm(${index})">${t('deleteAction')}</button>
            </div>
        </div>
    `).join('');
}

function toggleFavoriteByIndex(index, event) {
    event?.stopPropagation();
    const accounts = getStoredAccounts();
    if (!accounts[index]) return;

    toggleFavorite(accounts[index].name, event);
}

function openDeleteConfirm(index) {
    pendingDeleteIndex = index;
    pendingDeleteVersionId = null;
    pendingConfirmAction = () => {
        if (pendingDeleteIndex !== null) {
            deleteAccount(pendingDeleteIndex);
            pendingDeleteIndex = null;
        }
    };
    const confirmTitle = document.querySelector('#custom-confirm h2');
    const confirmDesc = document.querySelector('#custom-confirm p');

    if (confirmTitle) confirmTitle.innerText = '¿Eliminar esta cuenta?';
    if (confirmDesc) confirmDesc.innerText = 'Esta acción no se puede deshacer.';

    const confirmPanel = document.getElementById('custom-confirm');
    if (!confirmPanel) return;
    confirmPanel.classList.remove('hidden');
}

function addAccountToStorage(newAcc) {
    const normalizedNewAccount = normalizeAccount(newAcc);
    if (!normalizedNewAccount) return null;

    const accounts = getStoredAccounts();
    const existingAccountIndex = accounts.findIndex((acc) => acc.name.toLowerCase() === normalizedNewAccount.name.toLowerCase());
    const existingAccount = existingAccountIndex !== -1 ? accounts[existingAccountIndex] : null;

    if (existingAccount) {
        const mergedAccount = { ...existingAccount, ...normalizedNewAccount };
        accounts[existingAccountIndex] = mergedAccount;
        saveStoredAccounts(accounts);
        return mergedAccount;
    }

    accounts.push({ ...normalizedNewAccount, isFavorite: Boolean(normalizedNewAccount.isFavorite) });
    saveStoredAccounts(accounts);
    return normalizedNewAccount;
}

function selectAccount(acc, options = {}) {
    const { closeModal: shouldCloseModal = true, updateList = true } = options;
    const accounts = getStoredAccounts();
    const selectedAccount = typeof acc === 'string'
        ? accounts.find((item) => item.name.toLowerCase() === String(acc).toLowerCase())
        : normalizeAccount(acc);

    if (!selectedAccount) return;

    const storedAccount = accounts.find((item) => item.name.toLowerCase() === selectedAccount.name.toLowerCase()) || selectedAccount;
    currentAccount = storedAccount;

    const userName = document.getElementById('user-name');
    if (userName) userName.innerText = storedAccount.name;

    const select = document.getElementById('account-select');
    const selectedIndex = accounts.findIndex((item) => item.name.toLowerCase() === storedAccount.name.toLowerCase());
    if (select && selectedIndex !== -1) {
        select.disabled = false;
        select.value = String(selectedIndex);
    }

    setUserAvatar(storedAccount.name, storedAccount.avatar);
    actualizarVisualizacionSkin(storedAccount.name);
    loadCurrentAccountSkin();
    if (miVisor3D) {
        const avatar = getCachedAvatar(storedAccount.name);
        if (avatar) miVisor3D.loadSkin(avatar);
    }
    // Cargar librería de skins del usuario
    skinLibrary = JSON.parse(localStorage.getItem(getSkinLibraryKey(storedAccount.name)) || '[]');
    renderSkinLibrary();
    if (firebaseReady) {
        loadRemoteSkinLibrary(storedAccount).catch((error) => {
            console.warn('No se pudo cargar la librería remota de skins:', error);
        });
    }
    updateWelcomeMessage(storedAccount.name);

    const offlineNameInput = document.getElementById('offline-name');
    if (offlineNameInput) offlineNameInput.value = storedAccount.name;

    ipc.send('update-username', storedAccount.name);
    updateDiscordStatus('En el menú');
    stopFriendsRealtimeSync();
    closeFriendProfile();

    if (activeSection === 'friends') {
        renderFriendsPanel();
    }

    if (updateList) {
        renderAccountList();
        renderLoginAccounts();
        renderAccountSelector();
        renderAccountEditList();
    }

    if (shouldCloseModal) {
        closeAccountModal();
    }
}

function openAccountModal() {
    renderAccountList();
    const modal = document.getElementById('account-modal');
    if (modal) modal.classList.remove('hidden');
}

function closeAccountModal() {
    const modal = document.getElementById('account-modal');
    if (modal) modal.classList.add('hidden');
}

function showAddAccountScreen() {
    closeAccountModal();
    showScreen('screen-login-choice');
}

function renderAccountList() {
    const container = document.getElementById('account-list-container');
    if (!container) return;

    const accounts = getStoredAccounts();
    container.innerHTML = '';

    if (accounts.length === 0) {
        container.innerHTML = `<p class="empty-text">${t('noAccounts')}</p>`;
        return;
    }

    accounts.forEach((acc) => {
        const isActive = currentAccount && currentAccount.name.toLowerCase() === acc.name.toLowerCase();
        const item = document.createElement('div');
        item.className = `account-item ${isActive ? 'active' : ''}`;
        item.addEventListener('click', () => selectAccount(acc));

        const avatar = document.createElement('img');
        avatar.src = acc.avatar || getCachedAvatar(acc.name) || createOfflineAvatar(acc.name);
        avatar.alt = acc.name;
        avatar.onerror = () => {
            avatar.onerror = null;
            avatar.src = createOfflineAvatar(acc.name);
        };

        const info = document.createElement('div');
        info.className = 'account-info';

        const name = document.createElement('span');
        name.className = 'account-name';
        name.innerText = acc.name;

        const type = document.createElement('span');
        type.className = 'account-type';
        type.innerText = acc.type === 'premium' ? t('premiumMicrosoft') : t('offlineAccountLabel');

        info.appendChild(name);
        info.appendChild(type);

        const actions = document.createElement('div');
        actions.className = 'account-actions';

        const favoriteBtn = document.createElement('button');
        favoriteBtn.className = `btn-icon ${acc.isFavorite ? 'favorite' : 'not-favorite'}`;
        favoriteBtn.title = 'Marcar como favorita para Auto-Login';
        favoriteBtn.innerHTML = `<i class="fa-${acc.isFavorite ? 'solid' : 'regular'} fa-star"></i>`;
        favoriteBtn.addEventListener('click', (event) => toggleFavorite(acc.name, event));

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn-icon delete';
        deleteBtn.title = 'Eliminar cuenta';
        deleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        deleteBtn.addEventListener('click', (event) => deleteAccount(acc.name, event));

        actions.appendChild(favoriteBtn);
        actions.appendChild(deleteBtn);

        item.appendChild(avatar);
        item.appendChild(info);
        item.appendChild(actions);

        container.appendChild(item);
    });
}

function toggleFavorite(username, event) {
    event?.stopPropagation();

    const targetName = String(username).toLowerCase();
    const accounts = getStoredAccounts();
    const targetAccount = accounts.find((account) => account.name.toLowerCase() === targetName);
    const isSingleAccount = accounts.length === 1;
    const shouldSetFavorite = isSingleAccount || !(targetAccount && targetAccount.isFavorite);

    const updatedAccounts = accounts.map((account) => ({
        ...account,
        isFavorite: shouldSetFavorite && account.name.toLowerCase() === targetName
    }));

    saveStoredAccounts(updatedAccounts);
    renderAccountList();
    renderLoginAccounts();
    renderAccountSelector();
    renderAccountEditList();
    loadAccounts();

    if (isSingleAccount) {
        showToast(t('singleAccountFavorite'));
    } else {
        showToast(shouldSetFavorite ? t('favoriteSet') : t('favoriteRemoved'));
    }
}

function deleteAccount(target, event) {
    event?.stopPropagation();

    let accounts = getStoredAccounts();
    const username = typeof target === 'number'
        ? accounts[target]?.name
        : String(target || '').trim();

    if (!username) return;

    accounts = accounts.filter((acc) => acc.name.toLowerCase() !== username.toLowerCase());
    saveStoredAccounts(accounts);

    if (currentAccount && currentAccount.name.toLowerCase() === username.toLowerCase()) {
        if (accounts.length > 0) {
            const nextAccount = accounts.find((acc) => acc.isFavorite) || accounts[0];
            selectAccount(nextAccount, { closeModal: false, updateList: false });
        } else {
            currentAccount = null;
            const userName = document.getElementById('user-name');
            if (userName) userName.innerText = 'Usuario';
            setUserAvatar('Steve');
            updateWelcomeMessage();
            closeAccountModal();
            showScreen('screen-login-choice');
        }
    }

    renderAccountList();
    renderLoginAccounts();
    renderAccountSelector();
    renderAccountEditList();
    loadAccounts();
    showToast('Cuenta eliminada');
}

function toggleEditAccounts() {
    const panel = document.getElementById('account-edit-panel');
    if (!panel) return;

    panel.classList.toggle('hidden');
    renderAccountEditList();
}

function switchAccount() {
    const accounts = getStoredAccounts();
    const select = document.getElementById('account-select');
    if (!select) return;

    const index = Number(select.value);
    if (!Number.isNaN(index) && accounts[index]) {
        selectAccount(accounts[index], { closeModal: false, updateList: true });
    }
}

function logout() {
    stopFriendsRealtimeSync();
    closeFriendProfile();
    currentAccount = null;
    const userName = document.getElementById('user-name');
    if (userName) userName.innerText = 'Usuario';
    setUserAvatar('Steve');
    updateWelcomeMessage();
    updateDiscordStatus('En el menú');
    closeAccountModal();

    if (getStoredAccounts().length > 0) {
        showScreen('screen-account-selector');
    } else {
        showScreen('screen-login-choice');
    }
}

// --- GESTOR DE CUENTAS PRINCIPAL ---
function renderAccountSelector() {
    const grid = document.getElementById('accounts-grid');
    if (!grid) return;

    const accounts = getStoredAccounts().sort((a, b) => Number(Boolean(b.isFavorite)) - Number(Boolean(a.isFavorite)) || a.name.localeCompare(b.name));
    grid.innerHTML = '';

    accounts.forEach((acc) => {
        const card = document.createElement('div');
        card.className = `account-card ${acc.isFavorite ? 'is-fav' : ''}`;
        card.addEventListener('click', () => loginWithAccount(acc.name));

        const avatarWrapper = document.createElement('div');
        avatarWrapper.className = 'card-avatar';

        const avatar = document.createElement('img');
        avatar.src = acc.avatar || getCachedAvatar(acc.name) || createOfflineAvatar(acc.name);
        avatar.alt = acc.name;
        avatar.onerror = () => {
            avatar.onerror = null;
            avatar.src = createOfflineAvatar(acc.name);
        };
        avatarWrapper.appendChild(avatar);

        if (acc.isFavorite) {
            const favoriteBadge = document.createElement('i');
            favoriteBadge.className = 'fa-solid fa-star fav-badge';
            avatarWrapper.appendChild(favoriteBadge);
        }

        const name = document.createElement('span');
        name.className = 'card-name';
        name.innerText = acc.name;

        const type = document.createElement('small');
        type.className = 'card-type';
        type.innerText = acc.type === 'premium' ? t('premiumTitle') : t('offlineTitle');

        const actions = document.createElement('div');
        actions.className = 'card-actions';

        const favoriteBtn = document.createElement('button');
        favoriteBtn.type = 'button';
        favoriteBtn.title = 'Favorito';
        favoriteBtn.innerHTML = `<i class="${acc.isFavorite ? 'fa-solid' : 'fa-regular'} fa-star"></i>`;
        favoriteBtn.addEventListener('click', (event) => toggleFavoriteLogin(acc.name, event));

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn-del';
        deleteBtn.title = 'Borrar';
        deleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        deleteBtn.addEventListener('click', (event) => deleteAccountWithToast(acc.name, event));

        actions.appendChild(favoriteBtn);
        actions.appendChild(deleteBtn);

        card.appendChild(avatarWrapper);
        card.appendChild(name);
        card.appendChild(type);
        card.appendChild(actions);
        grid.appendChild(card);
    });

    const addCard = document.createElement('div');
    addCard.className = 'account-card add-new';
    addCard.addEventListener('click', () => showScreen('screen-login-choice'));
    addCard.innerHTML = `
        <div class="card-avatar"><i class="fa-solid fa-plus"></i></div>
        <span class="card-name">${t('addAccountLabel')}</span>
    `;
    grid.appendChild(addCard);
}

function deleteAccountWithToast(username, event) {
    event?.stopPropagation();
    deleteAccount(username, event);
    renderAccountSelector();
}

// --- SISTEMA SOCIAL / DISCORD ---
function getActiveAccountName() {
    const visibleName = String(currentAccount?.name || document.getElementById('user-name')?.innerText || '').trim();
    return /^(usuario|user|invitado)$/i.test(visibleName) ? '' : visibleName;
}

function readJsonStorage(key, fallback = null) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

function getDiscordLinkStorageKey(accountName = getActiveAccountName()) {
    const safeAccount = String(accountName || '').trim().toLowerCase();
    return safeAccount ? `azureDiscordLink:${safeAccount}` : 'azureDiscordLink';
}

function getDiscordLinkData(accountName = getActiveAccountName()) {
    const scopedKey = getDiscordLinkStorageKey(accountName);
    const scopedLink = readJsonStorage(scopedKey, null);
    if (scopedLink) return scopedLink;

    const legacyLink = readJsonStorage('azureDiscordLink', null);
    if (!legacyLink) return null;

    const legacyNick = String(legacyLink.mcNick || '').trim().toLowerCase();
    if (!accountName || !legacyNick || legacyNick === String(accountName || '').trim().toLowerCase()) {
        if (accountName) {
            localStorage.setItem(scopedKey, JSON.stringify(legacyLink));
        }
        return legacyLink;
    }

    return null;
}

function saveDiscordLinkData(linkData, accountName = linkData?.mcNick || getActiveAccountName()) {
    const payload = {
        ...linkData,
        mcNick: linkData?.mcNick || accountName || linkData?.mcNick || ''
    };

    localStorage.setItem(getDiscordLinkStorageKey(accountName), JSON.stringify(payload));
    localStorage.setItem('azureDiscordLink', JSON.stringify(payload));
}

function removeDiscordLinkData(accountName = getActiveAccountName()) {
    const scopedKey = getDiscordLinkStorageKey(accountName);
    localStorage.removeItem(scopedKey);

    const legacyLink = readJsonStorage('azureDiscordLink', null);
    const legacyNick = String(legacyLink?.mcNick || '').trim().toLowerCase();
    if (!accountName || !legacyNick || legacyNick === String(accountName || '').trim().toLowerCase()) {
        localStorage.removeItem('azureDiscordLink');
    }
}

function normalizeFriendsStoreData(parsed = {}) {
    return {
        pendingRequests: Array.isArray(parsed?.pendingRequests) ? parsed.pendingRequests : [],
        friends: Array.isArray(parsed?.friends) ? parsed.friends : []
    };
}

function getFriendsStoreStorageKey(identity = getLinkedIdentity() || getActiveAccountName()) {
    const safeIdentity = String(identity || 'default').trim();
    return safeIdentity ? `azureFriendsStore:${cleanFriendKey(safeIdentity)}` : 'azureFriendsStore';
}

function getFriendsStore(identity = getLinkedIdentity() || getActiveAccountName()) {
    const scopedStore = readJsonStorage(getFriendsStoreStorageKey(identity), null);
    if (scopedStore) {
        return normalizeFriendsStoreData(scopedStore);
    }

    return normalizeFriendsStoreData(readJsonStorage('azureFriendsStore', {}));
}

function saveFriendsStore(store, identity = getLinkedIdentity() || getActiveAccountName()) {
    const payload = normalizeFriendsStoreData(store);
    localStorage.setItem(getFriendsStoreStorageKey(identity), JSON.stringify(payload));

    const activeIdentity = getLinkedIdentity() || getActiveAccountName();
    if (!identity || String(identity).trim() === String(activeIdentity || '').trim()) {
        localStorage.setItem('azureFriendsStore', JSON.stringify(payload));
    }
}

function getDiscordIdSuffix(userData = {}) {
    const rawId = String(userData.discordId || userData.id || '').replace(/\D/g, '');
    return rawId ? rawId.slice(-4).padStart(4, '0') : '0000';
}

function cleanFriendKey(tag = '') {
    return String(tag || '').trim().replace(/[.#$\[\]]/g, '_');
}

function getLinkedIdentity() {
    const linkData = getDiscordLinkData();
    if (!linkData) return '';

    const suffix = getDiscordIdSuffix(linkData);
    return linkData.fullIdentity || (linkData.mcNick ? `${linkData.mcNick}#${suffix}` : '');
}

function buildProtectedCapturePlaceholder(label = 'Sin captura destacada') {
    const safeLabel = String(label || 'Sin captura destacada').replace(/[<>&"']/g, '');
    const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="900" height="460" viewBox="0 0 900 460">
            <defs>
                <linearGradient id="captureBg" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#041426" />
                    <stop offset="55%" stop-color="#0f427e" />
                    <stop offset="100%" stop-color="#06131f" />
                </linearGradient>
            </defs>
            <rect width="900" height="460" rx="24" fill="url(#captureBg)" />
            <circle cx="180" cy="120" r="80" fill="rgba(255,255,255,0.08)" />
            <circle cx="760" cy="340" r="100" fill="rgba(78,205,196,0.18)" />
            <text x="50%" y="44%" dominant-baseline="middle" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="34" fill="#ffffff">Azure Friends</text>
            <text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="24" fill="#c8e7ff">${safeLabel}</text>
        </svg>
    `.trim();

    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function getCurrentPresenceSnapshot() {
    const linkData = getDiscordLinkData();
    const fallbackNick = linkData?.mcNick || currentAccount?.name || document.getElementById('user-name')?.innerText?.trim() || 'Jugador';
    const countryText = document.getElementById('country-text')?.innerText?.trim();
    const timeText = document.getElementById('time-text')?.innerText?.trim();

    const serversSource = privacyServerCache.length > 0 ? privacyServerCache : DEFAULT_FRIEND_SERVERS;
    const topServers = isShareTopServers
        ? serversSource.slice(0, 3).map(s => (s.ip || s.name || '').toString()).filter(Boolean)
        : [];

    return {
        nick: fallbackNick,
        avatar: document.getElementById('user-avatar')?.src || getCachedAvatar(fallbackNick) || createOfflineAvatar(fallbackNick),
        country: countryText && !/cargando/i.test(countryText)
            ? countryText
            : (localStorage.getItem(COUNTRY_CACHE_KEY) || guessCountryOffline() || t('unknown')),
        localTime: isHideLocalTime ? 'Oculto' : (timeText || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
        status: navigator.onLine ? 'online' : 'offline',
        topServers,
        favCapture: favoriteScreenshot || buildProtectedCapturePlaceholder(`Captura de ${fallbackNick}`)
    };
}

function enrichFriendEntry(friend = {}) {
    const resolvedTag = String(friend.tag || friend.from || (friend.nick ? `${friend.nick}#0000` : '')).trim();
    const presence = resolvedTag ? (cachedFriendsPresence[cleanFriendKey(resolvedTag)] || {}) : {};
    const merged = { ...friend, ...presence };
    const nick = String(merged.nick || resolvedTag.split('#')[0] || 'Jugador').trim() || 'Jugador';
    const avatar = merged.avatar || getCachedAvatar(nick) || buildAvatarUrl(nick);
    const status = merged.status === 'offline' || merged.online === false ? 'offline' : 'online';

    return {
        id: merged.id || merged.requestKey || cleanFriendKey(resolvedTag || nick),
        requestKey: merged.requestKey || cleanFriendKey(resolvedTag || nick),
        nick,
        tag: resolvedTag || `${nick}#0000`,
        avatar,
        country: merged.country || localStorage.getItem(COUNTRY_CACHE_KEY) || guessCountryOffline() || t('unknown'),
        localTime: merged.localTime || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        online: status === 'online',
        status,
        topServers: Array.isArray(merged.topServers) && merged.topServers.length > 0
            ? merged.topServers.slice(0, 3)
            : DEFAULT_FRIEND_SERVERS.slice(0, 3),
        favCapture: merged.favCapture || buildProtectedCapturePlaceholder(`Captura de ${nick}`),
        updatedAt: merged.updatedAt || merged.timestamp || Date.now()
    };
}

function dedupeFriendEntries(entries = []) {
    const unique = new Map();

    entries.forEach((entry) => {
        const enriched = enrichFriendEntry(entry);
        const key = String(enriched.tag || enriched.id).toLowerCase();
        if (key) unique.set(key, enriched);
    });

    return Array.from(unique.values());
}

function saveSyncedFriendsStore(pendingRequests = [], friends = [], identity = activeFriendsIdentity || getLinkedIdentity() || getActiveAccountName()) {
    saveFriendsStore({
        pendingRequests: dedupeFriendEntries(pendingRequests),
        friends: dedupeFriendEntries(friends)
    }, identity);
}

function ensureFriendsPresenceHeartbeat() {
    if (friendsPresenceInterval || !firebaseReady) return;

    friendsPresenceInterval = setInterval(() => {
        syncPresenceToFirebase();
    }, 60000);
}

function stopFriendsRealtimeSync() {
    friendsRealtimeUnsubs.forEach((unsubscribe) => {
        try {
            if (typeof unsubscribe === 'function') unsubscribe();
        } catch {
            // noop
        }
    });

    friendsRealtimeUnsubs = [];
    activeFriendsIdentity = '';
    cachedFriendsPresence = {};
}

function syncPresenceToFirebase() {
    if (!firebaseReady || !firebaseDb || !firebaseFns) return Promise.resolve();

    const identity = getLinkedIdentity();
    if (!identity) return Promise.resolve();

    const snapshot = getCurrentPresenceSnapshot();
    return firebaseFns.set(firebaseFns.ref(firebaseDb, `presencia/${cleanFriendKey(identity)}`), {
        tag: identity,
        nick: snapshot.nick,
        avatar: snapshot.avatar,
        country: snapshot.country,
        localTime: snapshot.localTime,
        status: snapshot.status,
        online: snapshot.status === 'online',
        topServers: snapshot.topServers,
        favCapture: snapshot.favCapture,
        updatedAt: Date.now()
    }).catch((error) => {
        console.warn('No se pudo sincronizar presencia en Firebase:', error?.message || error);
    });
}

function startFriendsRealtimeSync() {
    if (!firebaseReady || !firebaseDb || !firebaseFns) return;

    const identity = getLinkedIdentity();
    if (!identity) return;

    // 1. EVITAR CONGELAMIENTOS: Limpiar escuchadores anteriores
    friendsRealtimeUnsubs.forEach(unsub => unsub());
    friendsRealtimeUnsubs = [];
    if (friendsPresenceInterval) {
        clearInterval(friendsPresenceInterval);
    }

    activeFriendsIdentity = cleanFriendKey(identity);
    ensureFriendsPresenceHeartbeat();

    const { ref, onValue } = firebaseFns;

    // 2. Escuchar Solicitudes
    const reqRef = ref(firebaseDb, `solicitudes/${activeFriendsIdentity}`);
    const unsubReq = onValue(reqRef, (snapshot) => {
        const currentStore = getFriendsStore();
        const previousIds = new Set(currentStore.pendingRequests.map((item) => item.requestKey || item.id));
        const data = snapshot.val() || {};
        const pendingRequests = Object.entries(data).map(([requestKey, item]) => enrichFriendEntry({
            ...item,
            id: item?.id || requestKey,
            requestKey,
            tag: item?.tag || item?.from,
            nick: item?.nick || String(item?.tag || item?.from || '').split('#')[0]
        }));

        pendingRequests.forEach((request) => {
            const identifier = request.requestKey || request.id;
            if (identifier && !previousIds.has(identifier)) {
                showToast(`Nueva solicitud de ${request.tag}`);
            }
        });

        saveSyncedFriendsStore(pendingRequests, currentStore.friends);
        if (activeSection === 'friends') renderFriendsPanel();
    });
    friendsRealtimeUnsubs.push(() => {
        firebaseFns.off(reqRef);
    });

    // 3. Escuchar Amigos Activos
    const friendsRef = ref(firebaseDb, `amigos/${activeFriendsIdentity}`);
    const unsubFriends = onValue(friendsRef, (snapshot) => {
        const currentStore = getFriendsStore();
        const data = snapshot.val() || {};
        const friends = Object.entries(data).map(([friendKey, item]) => enrichFriendEntry({
            ...item,
            id: item?.id || friendKey,
            requestKey: friendKey,
            tag: item?.tag || `${item?.nick || 'Jugador'}#0000`
        }));

        saveSyncedFriendsStore(currentStore.pendingRequests, friends);
        if (activeSection === 'friends') renderFriendsPanel();
    });
    friendsRealtimeUnsubs.push(() => {
        firebaseFns.off(friendsRef);
    });

    // 4. Actualizar MI presencia (Estoy conectado en el launcher)
    updateMyPresence();
    friendsPresenceInterval = setInterval(updateMyPresence, 60000); // Cada 1 minuto, no cada 30s

    // ESCUCHAR TRANSFERENCIAS ENTRANTES
    const transfersRef = ref(firebaseDb, `transferencias/${activeFriendsIdentity}`);
    onValue(transfersRef, (snapshot) => {
        const data = snapshot.val();
        const container = document.getElementById('transfers-list');
        if (!container) return;
        
        container.innerHTML = '';
        if (data) {
            Object.keys(data).forEach(key => {
                const trans = data[key];
                const icon = trans.tipo === 'ip' ? 'fa-server' : 'fa-image';
                
                container.innerHTML += `
                    <div class="friend-card" style="border-left: 3px solid var(--accent-light);">
                        <div class="friend-info">
                            <span class="friend-name"><i class="fa-solid ${icon}"></i> De: ${trans.remitente}</span>
                            <span class="friend-status-text">Quiere enviarte una ${trans.tipo}</span>
                        </div>
                        <div class="friend-actions">
                            <button class="c-btn btn-accept" onclick="aceptarTransferencia('${key}', '${trans.tipo}', '${trans.contenido}')">
                                <i class="fa-solid fa-check"></i>
                            </button>
                            <button class="c-btn btn-secondary" onclick="rechazarTransferencia('${key}')">
                                <i class="fa-solid fa-xmark"></i>
                            </button>
                        </div>
                    </div>
                `;
            });
        }
    });
}

async function unlinkDiscordAccount() {
    // Usamos tu sistema de modales para mostrar peligro
    const confirm = await showConfirmModal(
        t('unlinkTitle'),
        t('unlinkConfirm'),
        'danger' // <- Esto debería poner los botones en rojo si tienes el CSS configurado
    );

    if (confirm) {
        const currentTag = getLinkedIdentity();
        if (currentTag && firebaseDb && firebaseFns) {
            const cleanId = cleanFriendKey(currentTag);
            // BORRAR TODO RASTRO DE FIREBASE
            await firebaseFns.remove(firebaseFns.ref(firebaseDb, `amigos/${cleanId}`));
            await firebaseFns.remove(firebaseFns.ref(firebaseDb, `solicitudes/${cleanId}`));
            await firebaseFns.remove(firebaseFns.ref(firebaseDb, `presencia/${cleanId}`));
            await firebaseFns.remove(firebaseFns.ref(firebaseDb, `transferencias/${cleanId}`)); // Por si acaso
        }

        stopFriendsRealtimeSync();
        removeDiscordLinkData();
        localStorage.removeItem(getFriendsStoreStorageKey());
        localStorage.removeItem('azureFriendsStore');
        showToast('Eliminado', 'Tu perfil ha sido borrado de la red', 'info');
        
        setTimeout(() => location.reload(), 1500);
    }
}

async function eliminarCuentaYDesvincular() {
    const confirm = await showConfirmModal(
        t('deleteAccountTitle'),
        t('unlinkConfirm'),
        'danger'
    );

    if (!confirm) return;

    const myTag = localStorage.getItem('discord_user') || getLinkedIdentity();
    if (myTag && firebaseReady && firebaseDb && firebaseFns) {
        const myKey = clean(myTag);
        try {
            await firebaseFns.remove(firebaseFns.ref(firebaseDb, `perfiles/${myKey}`));
            await firebaseFns.remove(firebaseFns.ref(firebaseDb, `amigos/${myKey}`));
            await firebaseFns.remove(firebaseFns.ref(firebaseDb, `solicitudes/${myKey}`));
            await firebaseFns.remove(firebaseFns.ref(firebaseDb, `presencia/${myKey}`));
            await firebaseFns.remove(firebaseFns.ref(firebaseDb, `transferencias/${myKey}`));

            localStorage.clear();
            showToast('Azure', 'Cuenta eliminada de la red.', 'info');
            setTimeout(() => location.reload(), 2000);
            return;
        } catch (e) {
            console.error('Error eliminando cuenta:', e);
            showToast('Error', 'No se pudo completar el borrado.', 'error');
        }
    }
    showToast('Error', 'No se pudo completar el borrado.', 'error');
}

function renderFriendsPanel() {
    const panel = document.getElementById('friends-panel');
    if (!panel) return;

    const linkData = getDiscordLinkData();
    if (!linkData) {
        panel.innerHTML = `
            <div class="friends-empty-state">
                <i class="fa-brands fa-discord friends-discord-icon"></i>
                <h3>${t('friendsPromptTitle')}</h3>
                <p>${t('friendsPromptDesc')}</p>
                <button class="btn-primary" onclick="openDiscordLinkModal()">
                    <i class="fa-brands fa-discord"></i> ${t('linkDiscordBtn')}
                </button>
            </div>
        `;
        return;
    }

    const identitySuffix = getDiscordIdSuffix(linkData);
    const resolvedIdentity = linkData.mcNick
        ? `${linkData.mcNick}#${identitySuffix}`
        : (linkData.fullIdentity || `Player#${identitySuffix}`);

    if (linkData.fullIdentity !== resolvedIdentity || linkData.discordTag !== identitySuffix) {
        saveDiscordLinkData({
            ...linkData,
            discordTag: identitySuffix,
            fullIdentity: resolvedIdentity
        });
    }

    if (firebaseReady) {
        startFriendsRealtimeSync();
    }

    const store = getFriendsStore();
    const pendingHtml = store.pendingRequests.length > 0
        ? store.pendingRequests.map((friend) => `
            <div class="friend-item">
                <div class="friend-card-main">
                    <img class="friend-avatar" src="${escapeHtml(friend.avatar || buildAvatarUrl(friend.nick))}" alt="${escapeHtml(friend.nick)}">
                    <div class="friend-meta">
                        <strong>${escapeHtml(friend.nick)}</strong>
                        <small>${escapeHtml(friend.tag)}</small>
                        <small class="friend-presence">${escapeHtml(friend.country || t('unknown'))} · ${escapeHtml(friend.localTime || '--:--')}</small>
                    </div>
                </div>
                <div class="friend-actions">
                    <button class="btn-small accept" onclick="acceptFriendRequest('${friend.id}')">${t('acceptRequest')}</button>
                    <button class="btn-small reject" onclick="rejectFriendRequest('${friend.id}')">${t('rejectRequest')}</button>
                </div>
            </div>
        `).join('')
        : `<p class="empty-text">${t('noRequests')}</p>`;

    const friendsHtml = store.friends.length > 0
        ? store.friends.map((friend) => `
            <div class="friend-item friend-clickable" onclick="openFriendProfile(decodeURIComponent('${encodeURIComponent(friend.tag)}'))" title="Ver perfil de ${escapeHtml(friend.nick)}">
                <div class="friend-card-main">
                    <img class="friend-avatar" src="${escapeHtml(friend.avatar || buildAvatarUrl(friend.nick))}" alt="${escapeHtml(friend.nick)}">
                    <div class="friend-meta">
                        <strong>${escapeHtml(friend.nick)}</strong>
                        <small>${escapeHtml(friend.tag)}</small>
                        <small class="friend-presence">${escapeHtml(friend.country || t('unknown'))} · ${escapeHtml(friend.localTime || '--:--')}</small>
                    </div>
                </div>
                <div class="friend-actions">
                    <button class="btn-small remove" onclick="event.stopPropagation(); removeFriend('${friend.tag}')" title="Eliminar amigo">×</button>
                </div>
                <span class="${friend.online ? 'status-online' : 'status-offline'}">${friend.online ? '●' : '●'}</span>
            </div>
        `).join('')
        : `<p class="empty-text">${t('noFriends')}</p>`;

    panel.innerHTML = `
        <div class="friends-shell">
            <div class="friends-hero-card">
                <div>
                    <h3>${t('linkedAs')}</h3>
                    <div class="user-tag-badge">${escapeHtml(resolvedIdentity)}</div>
                    <small class="friends-sync-badge">${firebaseReady ? '' : 'Modo local'}</small>
                </div>
                <div class="friends-hero-actions">
                    <div class="friend-request-inline">
                        <input id="friend-request-input" class="friend-request-input" type="text" placeholder="${escapeHtml(t('friendTagPlaceholder'))}">
                        <button class="btn-primary" onclick="sendFriendRequest()">
                            <i class="fa-solid fa-user-plus"></i> ${t('sendRequest')}
                        </button>
                    </div>
                    <button class="btn-secondary" onclick="openPrivacyModal()">
                        <i class="fa-solid fa-gear"></i> Ajustes de cuenta
                    </button>
                    <button class="btn-secondary danger" onclick="unlinkDiscordAccount()">
                        <i class="fa-solid fa-link-slash"></i> ${t('unlinkDiscordBtn')}
                    </button>
                </div>
            </div>
            <div class="friends-grid-layout">
                <div class="friends-column-card">
                    <h4>${t('pendingRequestsTitle')}</h4>
                    ${pendingHtml}
                </div>
                <div class="friends-column-card">
                    <h4>${t('friendsTab')}</h4>
                    ${friendsHtml}
                </div>
                <div class="friends-column-card">
                    <h4>Transferencias Entrantes</h4>
                    <div id="transfers-list" class="friends-grid"></div>
                </div>
            </div>
        </div>
    `;
}

function openDiscordLinkModal() {
    const modal = document.getElementById('modal-discord-auth');
    if (!modal) return;

    document.getElementById('auth-step-1')?.classList.remove('hidden');
    document.getElementById('auth-step-2')?.classList.add('hidden');
    document.getElementById('auth-step-3')?.classList.add('hidden');
    modal.classList.remove('hidden');
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('hidden');
}

function showAccountSelection() {
    const accounts = getStoredAccounts();
    const list = document.getElementById('auth-account-list');

    if (!accounts.length) {
        showToast(t('noAccounts'));
        closeModal('modal-discord-auth');
        showOfflineLogin();
        return;
    }

    document.getElementById('auth-step-1')?.classList.add('hidden');
    document.getElementById('auth-step-2')?.classList.remove('hidden');

    if (!list) return;
    list.innerHTML = accounts.map((acc) => `
        <button class="auth-option" onclick="processDiscordLink('${acc.name.replace(/'/g, "\\'")}')">
            <img src="${acc.avatar || getCachedAvatar(acc.name) || createOfflineAvatar(acc.name)}" alt="${acc.name}">
            <span>${acc.name} · ${acc.type === 'premium' ? t('premiumTitle') : t('offlineTitle')}</span>
        </button>
    `).join('');
}

async function processDiscordLink(selectedNick) {
    try {
        const userData = await ipc.invoke('start-discord-link');
        const suffix = getDiscordIdSuffix(userData);
        const finalTag = `${selectedNick}#${suffix}`;

        saveDiscordLinkData({
            mcNick: selectedNick,
            discordUser: userData.username,
            discordTag: suffix,
            discordId: userData.id,
            fullIdentity: finalTag
        });

        document.getElementById('display-final-tag').innerText = finalTag;
        document.getElementById('auth-step-2')?.classList.add('hidden');
        document.getElementById('auth-step-3')?.classList.remove('hidden');
        startFriendsRealtimeSync();
        renderFriendsPanel();
    } catch (error) {
        console.error('No se pudo vincular Discord:', error);
        showToast(error.message || 'No se pudo vincular con Discord');
        closeModal('modal-discord-auth');
    }
}

function finalizeAuth() {
    const finalTag = document.getElementById('display-final-tag')?.innerText || '';
    if (finalTag && finalTag !== '...') {
        localStorage.setItem('discord_user', finalTag);
        const nameElement = document.getElementById('user-name');
        if (nameElement) nameElement.innerText = finalTag;
        document.getElementById('auth-modal')?.classList.add('hidden');
        showToast('Azure', '¡Cuenta vinculada!', 'success');

        startFriendsRealtimeSync();
        renderFriendsPanel();
        showSection('friends');

        if (firebaseReady) updateMyPresence();
        return;
    }

    showToast('Error', 'Finaliza el vínculo del Discord para continuar.', 'error');
}

function sendFriendRequest() {
    const input = document.getElementById('friend-request-input');
    const requestedTag = String(input?.value || '').trim();
    if (!requestedTag) {
        input?.focus();
        showToast(t('friendInvalidTag'));
        return;
    }

    const normalizedTag = requestedTag.replace(/\s+/g, '');
    const match = normalizedTag.match(/^([^#]{2,16})#(\d{4})$/);
    if (!match) {
        showToast(t('friendInvalidTag'));
        input?.focus();
        return;
    }

    const [, nick, suffix] = match;
    const finalTag = `${nick}#${suffix}`;
    const linkData = getDiscordLinkData();

    if (linkData?.fullIdentity?.toLowerCase() === finalTag.toLowerCase()) {
        showToast(t('friendSelfAdd'));
        return;
    }

    const store = getFriendsStore();
    const alreadyExists = [...store.pendingRequests, ...store.friends]
        .some((friend) => String(friend.tag || '').toLowerCase() === finalTag.toLowerCase());

    if (alreadyExists) {
        showToast(t('friendAlreadyExists'));
        return;
    }

    if (firebaseReady && firebaseDb && firebaseFns && linkData?.fullIdentity) {
        const myTag = linkData.fullIdentity;
        const myKey = cleanFriendKey(myTag);
        const targetKey = cleanFriendKey(finalTag);
        const snapshot = getCurrentPresenceSnapshot();

        firebaseFns.set(firebaseFns.ref(firebaseDb, `solicitudes/${targetKey}/${myKey}`), {
            id: myKey,
            nick: snapshot.nick,
            tag: myTag,
            from: myTag,
            avatar: snapshot.avatar,
            country: snapshot.country,
            localTime: snapshot.localTime,
            status: 'pending',
            topServers: snapshot.topServers,
            favCapture: snapshot.favCapture,
            timestamp: Date.now()
        }).then(() => {
            if (input) input.value = '';
            showToast(`${t('friendRequestSent')}: ${finalTag}`);
        }).catch((error) => {
            console.error('No se pudo enviar la solicitud a Firebase:', error);
            showToast('No se pudo enviar la solicitud en tiempo real');
        });
        return;
    }

    const snapshot = getCurrentPresenceSnapshot();
    const senderTag = linkData?.fullIdentity || `${snapshot.nick}#0000`;
    const targetStore = getFriendsStore(finalTag);
    const alreadyPendingLocally = [...targetStore.pendingRequests, ...targetStore.friends]
        .some((friend) => String(friend.tag || '').toLowerCase() === senderTag.toLowerCase());

    if (!alreadyPendingLocally) {
        const localRequestId = cleanFriendKey(senderTag);
        targetStore.pendingRequests.unshift({
            id: localRequestId,
            requestKey: localRequestId,
            nick: snapshot.nick,
            tag: senderTag,
            from: senderTag,
            avatar: snapshot.avatar,
            country: snapshot.country,
            localTime: snapshot.localTime,
            status: 'pending',
            online: false,
            topServers: snapshot.topServers,
            favCapture: snapshot.favCapture,
            timestamp: Date.now()
        });
        saveFriendsStore(targetStore, finalTag);
    }

    if (input) input.value = '';
    renderFriendsPanel();
    showToast(`${t('friendRequestSent')}: ${finalTag} (modo local)`);
}

async function acceptFriendRequest(requestId) {
    const store = getFriendsStore();
    const request = store.pendingRequests.find((item) => item.id === requestId || item.requestKey === requestId);
    if (!request) return;

    if (firebaseReady && firebaseDb && firebaseFns) {
        const myTag = getLinkedIdentity();
        const myKey = cleanFriendKey(myTag);
        const remoteKey = request.requestKey || cleanFriendKey(request.tag);
        const snapshot = getCurrentPresenceSnapshot();
        const acceptedAt = Date.now();

        const myRecord = {
            tag: myTag,
            nick: snapshot.nick,
            avatar: snapshot.avatar,
            country: snapshot.country,
            localTime: snapshot.localTime,
            status: snapshot.status,
            online: snapshot.status === 'online',
            topServers: snapshot.topServers,
            favCapture: snapshot.favCapture,
            updatedAt: acceptedAt
        };

        const remoteRecord = {
            ...request,
            status: 'online',
            online: true,
            updatedAt: acceptedAt
        };

        try {
            const updates = {};
            updates[`amigos/${myKey}/${remoteKey}`] = remoteRecord;
            updates[`amigos/${remoteKey}/${myKey}`] = myRecord;
            await firebaseFns.update(firebaseFns.ref(firebaseDb), updates);
            await firebaseFns.remove(firebaseFns.ref(firebaseDb, `solicitudes/${myKey}/${remoteKey}`));
            syncPresenceToFirebase();
            showToast(t('acceptRequest'));
        } catch (error) {
            console.error('Error al aceptar la solicitud en Firebase:', error);
            showToast('No se pudo aceptar la solicitud');
        }
        return;
    }

    store.pendingRequests = store.pendingRequests.filter((item) => item.id !== requestId);

    if (!store.friends.some((friend) => friend.tag === request.tag)) {
        store.friends.push({ id: request.id, nick: request.nick, tag: request.tag, online: true });
    }

    saveFriendsStore(store);
    renderFriendsPanel();
    showToast(t('acceptRequest'));
}

async function rejectFriendRequest(requestId) {
    const store = getFriendsStore();
    const request = store.pendingRequests.find((item) => item.id === requestId || item.requestKey === requestId);

    if (firebaseReady && firebaseDb && firebaseFns && request) {
        try {
            const myKey = cleanFriendKey(getLinkedIdentity());
            const remoteKey = request.requestKey || cleanFriendKey(request.tag);
            await firebaseFns.remove(firebaseFns.ref(firebaseDb, `solicitudes/${myKey}/${remoteKey}`));
            showToast(t('rejectRequest'));
        } catch (error) {
            console.error('Error al rechazar la solicitud en Firebase:', error);
            showToast('No se pudo rechazar la solicitud');
        }
        return;
    }

    store.pendingRequests = store.pendingRequests.filter((item) => item.id !== requestId);
    saveFriendsStore(store);
    renderFriendsPanel();
    showToast(t('rejectRequest'));
}

// ELIMINAR AMIGO (NUEVA FUNCIÓN)
async function removeFriend(friendTag) {
    const confirm = await showConfirmModal('Eliminar Amigo', `¿Seguro que deseas eliminar a ${friendTag}?`);
    if (!confirm) return;

    const myId = cleanFriendKey(getLinkedIdentity());
    const friendId = cleanFriendKey(friendTag);

    try {
        await firebaseFns.remove(firebaseFns.ref(firebaseDb, `amigos/${myId}/${friendId}`));
        await firebaseFns.remove(firebaseFns.ref(firebaseDb, `amigos/${friendId}/${myId}`)); // Lo borraste, él también te pierde
        showToast('Eliminado', 'Amigo eliminado', 'info');
    } catch (e) {
        showToast('Error', 'No se pudo eliminar al amigo', 'error');
    }
}

function openFriendProfile(friendTag) {
    const store = getFriendsStore();
    const friend = dedupeFriendEntries([...store.friends, ...store.pendingRequests])
        .find((item) => String(item.tag || '').toLowerCase() === String(friendTag || '').toLowerCase());

    if (!friend) return;

    const avatar = document.getElementById('fp-avatar');
    const name = document.getElementById('fp-name');
    const status = document.getElementById('fp-status');
    const serversList = document.getElementById('fp-servers');
    const captureImg = document.getElementById('fp-capture');
    const modal = document.getElementById('friend-profile-modal');

    if (!avatar || !name || !status || !serversList || !captureImg || !modal) return;

    avatar.src = friend.avatar || buildAvatarUrl(friend.nick);
    avatar.onerror = () => {
        avatar.onerror = null;
        avatar.src = buildAvatarUrl(friend.nick);
    };

    name.innerText = friend.tag;
    status.innerHTML = `<i class="fa-solid fa-circle" style="color: ${friend.online ? '#00ff88' : '#747f8d'}"></i> ${friend.online ? 'En línea' : 'Desconectado'}<br>${escapeHtml(friend.country || t('unknown'))} (${escapeHtml(friend.localTime || '--:--')})`;

    serversList.innerHTML = '';
    (Array.isArray(friend.topServers) && friend.topServers.length > 0 ? friend.topServers : DEFAULT_FRIEND_SERVERS)
        .slice(0, 3)
        .forEach((serverIp) => {
            const item = document.createElement('li');
            item.innerText = serverIp;
            serversList.appendChild(item);
        });

    captureImg.src = friend.favCapture || buildProtectedCapturePlaceholder(`Captura de ${friend.nick}`);
    captureImg.alt = `Captura favorita de ${friend.nick}`;
    modal.setAttribute('data-current-friend', friend.tag);
    modal.classList.remove('hidden');
}

function closeFriendProfile() {
    const modal = document.getElementById('friend-profile-modal');
    if (modal) modal.classList.add('hidden');
}

function requestTransfer(type) {
    const modal = document.getElementById('friend-profile-modal');
    const friendTag = modal?.getAttribute('data-current-friend') || 'tu amigo';

    if (type === 'ip') {
        showToast(`Tu IP se marcó para compartir con ${friendTag}`);
        return;
    }

    showToast(`Solicitud de captura enviada a ${friendTag}`);
}

// Transferencias a otros amigos usando Firebase
async function enviarDatoAFriend(friendTag, tipo, contenido) {
    if (!firebaseReady || !window.fbSet || !window.fbRef || !firebaseDb) {
        showToast('Error', 'Firebase no está disponible', 'error');
        return;
    }

    const myTag = localStorage.getItem('discord_user') || getLinkedIdentity();
    const friendKey = clean(friendTag);

    await window.fbSet(window.fbRef(firebaseDb, `transferencias/${friendKey}/${Date.now()}`), {
        remitente: myTag || 'desconocido',
        tipo,
        dato: contenido,
        timestamp: Date.now()
    });

    showToast('Enviado', `Enviando ${tipo} a ${friendTag}...`, 'success');
}

function escucharTransferencias() {
    const myTag = localStorage.getItem('discord_user') || getLinkedIdentity();
    if (!myTag || !firebaseReady || !window.fbOnValue || !window.fbRef || !firebaseDb) return;

    const myKey = clean(myTag);
    window.fbOnValue(window.fbRef(firebaseDb, `transferencias/${myKey}`), (snap) => {
        const data = snap.val() || {};
        const box = document.getElementById('transfer-notifications');
        if (!box) return;

        box.innerHTML = '';
        Object.keys(data).forEach((id) => {
            const item = data[id];
            const card = document.createElement('div');
            card.className = 'notif-card';
            card.innerHTML = `
                <span><b>${escapeHtml(item.remitente)}</b> te envió una ${escapeHtml(item.tipo)}</span>
                <button onclick="aceptarTransferencia('${escapeHtml(id)}', '${escapeHtml(item.tipo)}', '${escapeHtml(item.dato)}')">✅</button>
                <button onclick="rechazarTransferencia('${escapeHtml(id)}')">❌</button>
            `;
            box.appendChild(card);
        });
    });
}

// --- LÓGICA DE LA PANTALLA DE INICIO DE SESIÓN ---
function renderLoginAccounts() {
    const container = document.getElementById('offline-account-list') || document.getElementById('login-account-list');
    if (!container) return;

    const accounts = getStoredAccounts()
        .sort((a, b) => Number(Boolean(b.isFavorite)) - Number(Boolean(a.isFavorite)) || a.name.localeCompare(b.name));

    container.innerHTML = '';

    if (accounts.length === 0) {
        container.innerHTML = `<p class="login-account-empty">${t('noAccounts')}</p>`;
        return;
    }

    accounts.forEach((acc) => {
        const isActive = currentAccount && currentAccount.name.toLowerCase() === acc.name.toLowerCase();
        const item = document.createElement('div');
        item.className = `account-item ${isActive ? 'active' : ''}`;
        item.addEventListener('click', () => loginWithAccount(acc.name));

        const avatar = document.createElement('img');
        avatar.src = acc.avatar || getCachedAvatar(acc.name) || createOfflineAvatar(acc.name);
        avatar.alt = acc.name;
        avatar.onerror = () => {
            avatar.onerror = null;
            avatar.src = createOfflineAvatar(acc.name);
        };

        const info = document.createElement('div');
        info.className = 'account-info';

        const name = document.createElement('span');
        name.className = 'account-name';
        name.innerText = acc.name;

        const type = document.createElement('span');
        type.className = 'account-type';
        type.innerText = acc.type === 'premium' ? t('premiumMicrosoft') : t('offlineAccountLabel');

        info.appendChild(name);
        info.appendChild(type);

        const actions = document.createElement('div');
        actions.className = 'account-actions';

        const favoriteBtn = document.createElement('button');
        favoriteBtn.className = `btn-icon ${acc.isFavorite ? 'favorite' : 'not-favorite'}`;
        favoriteBtn.title = 'Marcar como favorita';
        favoriteBtn.innerHTML = `<i class="fa-${acc.isFavorite ? 'solid' : 'regular'} fa-star"></i>`;
        favoriteBtn.addEventListener('click', (event) => toggleFavoriteLogin(acc.name, event));

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn-icon delete';
        deleteBtn.title = 'Eliminar cuenta';
        deleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        deleteBtn.addEventListener('click', (event) => deleteAccountLogin(acc.name, event));

        actions.appendChild(favoriteBtn);
        actions.appendChild(deleteBtn);

        item.appendChild(avatar);
        item.appendChild(info);
        item.appendChild(actions);

        container.appendChild(item);
    });
}

function loginWithAccount(username) {
    const account = getStoredAccounts().find((acc) => acc.name === username || acc.username === username);
    if (!account) return;

    selectAccount(account, { closeModal: false, updateList: true });
    showScreen('screen-dashboard');
    showSection('servers');
}

function toggleFavoriteLogin(username, event) {
    event?.stopPropagation();
    toggleFavorite(username, event);
    renderLoginAccounts();
}

function deleteAccountLogin(username, event) {
    event?.stopPropagation();
    deleteAccount(username, event);
    renderLoginAccounts();
}

function loadVersionList() {
    migrateLegacyVersionList();
    renderVersionsUI();
}

// --- NUEVO: Cargar versiones reales instaladas en .minecraft/versions ---
async function loadInstalledVersions() {
    const versionSelect = document.getElementById('version-select');
    if (!versionSelect) return;

    try {
        const versions = await ipc.invoke('get-local-versions');

        if (!Array.isArray(versions) || versions.length === 0) {
            versionSelect.innerHTML = '<option value="">No hay versiones instaladas</option>';
            return;
        }

        versionSelect.innerHTML = versions.sort().map((v) => 
            `<option value="${v}">${v}</option>`
        ).join('');

        const ultimaVersion = localStorage.getItem('last_played_version');
        if (ultimaVersion && versions.includes(ultimaVersion)) {
            versionSelect.value = ultimaVersion;
        }
    } catch (error) {
        console.error('Error al cargar versiones instaladas:', error);
        versionSelect.innerHTML = '<option value="">Error al cargar versiones</option>';
    }
}

function addVersion() {
    const version = prompt('Ingresa la versión de Minecraft (ej. 1.20.4):');
    if (!version || !version.trim()) return;

    const versions = JSON.parse(localStorage.getItem('azureVersions') || '[]');
    versions.push(version.trim());
    localStorage.setItem('azureVersions', JSON.stringify(versions));
    loadVersionList();
}

function changeTab(id) {
    // Mantener compatibilidad antigua con tabs (puede dejarse para logs)
    console.log(`changeTab: ${id}`);
}

function showSection(section, element) {
    activeSection = section;
    document.querySelectorAll('.nav-item, .tab-btn').forEach(btn => btn.classList.remove('active'));

    const targetButton = element || Array.from(document.querySelectorAll('.section-tabs .tab-btn'))
        .find((btn) => btn.getAttribute('onclick')?.includes(`'${section}'`));
    if (targetButton) targetButton.classList.add('active');

    const playInfo = document.getElementById('play-info');
    const skinPanel = document.getElementById('skin-panel');
    const settingsPanel = document.getElementById('settings-panel');
    const ssGrid = document.getElementById('ss-grid');
    const serverList = document.getElementById('server-list');
    const friendsPanel = document.getElementById('friends-panel');
    const screenshotModal = document.getElementById('screenshot-modal');

    if (section !== 'servers') {
        stopServerRefresh();
    }

    if (playInfo) playInfo.classList.add('hidden');
    if (skinPanel) skinPanel.classList.add('hidden');
    if (settingsPanel) settingsPanel.style.display = 'none';
    if (serverList) {
        serverList.style.display = 'none';
        if (section !== 'servers') serverList.innerHTML = '';    }
    if (friendsPanel) friendsPanel.style.display = 'none';
    if (ssGrid) {
        ssGrid.style.display = 'none';
        if (section !== 'screenshots') ssGrid.innerHTML = '';    }

    if (section === 'play') {
        if (screenshotModal) screenshotModal.classList.add('hidden');
        if (playInfo) {
            playInfo.classList.add('hidden');
        }
        if (skinPanel) {
            skinPanel.classList.remove('hidden');
            skinPanel.style.display = 'flex';
        }
        if (typeof initSkinViewer === 'function') initSkinViewer();
    } else if (section === 'screenshots') {
        if (screenshotModal) screenshotModal.classList.remove('hidden');
        if (ssGrid) ssGrid.style.display = 'grid';
        if (typeof loadScreenshots === 'function') loadScreenshots();
    } else if (section === 'servers') {
        if (screenshotModal) screenshotModal.classList.add('hidden');
        if (serverList) serverList.style.display = 'grid';
        if (typeof openServers === 'function') openServers();
    } else if (section === 'friends') {
        if (screenshotModal) screenshotModal.classList.add('hidden');
        if (friendsPanel) friendsPanel.style.display = 'block';
        if (typeof renderFriendsPanel === 'function') renderFriendsPanel();
    } else if (section === 'settings') {
        if (screenshotModal) screenshotModal.classList.add('hidden');
        if (settingsPanel) settingsPanel.style.display = 'block';
    }
}

// Eliminamos confirm() nativo y usamos el modal interno.
function closeConfirm() {
    const confirmPanel = document.getElementById('custom-confirm');
    if (!confirmPanel) return;
    confirmPanel.classList.add('hidden');
}

function handleAcceptDelete() {
    const btn = document.getElementById('btn-confirm-accept');
    if (!btn) return;

    btn.classList.add('clicked');

    setTimeout(() => {
        btn.classList.remove('clicked');

        if (typeof pendingConfirmAction === 'function') {
            pendingConfirmAction();
            pendingConfirmAction = null;
        }

        closeConfirm();
    }, 350);
}

function showOfflineLogin(type = 'offline') {
    pendingLoginType = type === 'premium' ? 'premium' : 'offline';
    showScreen('screen-offline-login');
    renderLoginAccounts();

    const promptHeader = document.querySelector('#screen-offline-login .login-box h3');
    if (promptHeader) {
        promptHeader.innerText = type === 'premium'
            ? 'Introduce un nombre de usuario Premium (modo local)' 
            : t('offlinePrompt');
    }

    const input = document.getElementById('offline-name');
    if (input) {
        input.placeholder = t('usernamePlaceholder');
        setTimeout(() => input.focus(), 150);
    }
}

function loginOffline() {
    const input = document.getElementById('offline-name');
    const name = input?.value.trim() || '';

    if (name.length < 3) {
        showToast('Introduce un nombre válido');
        return;
    }

    const type = pendingLoginType === 'premium' ? 'premium' : 'offline';
    const account = addAccountToStorage({
        username: name,
        type,
        avatar: getCachedAvatar(name) || createOfflineAvatar(name)
    });

    if (!account) {
        showToast('Cuenta existente cargada.');
        return;
    }

    if (input) input.value = '';

    const toastMessage = type === 'premium'
        ? 'Cuenta Premium local creada y activada (modo prueba).'
        : 'Cuenta offline creada y activada.';
    showToast(toastMessage);

    selectAccount(account, { closeModal: false, updateList: true });
    ipc.send('update-discord', { username: name, status: 'En el menú', version: 'Menú Principal' });
    showScreen('screen-dashboard');
    showSection('play');
}

async function openMicrosoftLogin() {
    try {
        showToast('Abriendo login Microsoft...', 'info');
        const result = await ipc.invoke('login-microsoft');

        if (!result || result.success !== true || !result.account) {
            throw new Error(result?.error || 'No se recibió un perfil válido de Microsoft.');
        }

        const account = addAccountToStorage({
            name: result.account.username,
            username: result.account.username,
            type: 'premium',
            uuid: result.account.uuid,
            accessToken: result.account.accessToken,
            refreshToken: result.account.refreshToken || null,
            profile: result.account.profile,
            avatar: `https://minotar.net/helm/${encodeURIComponent(result.account.username)}/64`
        });

        selectAccount(account, { closeModal: false, updateList: true });
        ipc.send('update-discord', { username: account.name, status: 'En el menú', version: 'Menú Principal' });
        showToast(`¡Bienvenido ${account.name}! Cuenta Microsoft activada.`, 'success');

        // Vinculación automática de Discord
        autoLinkDiscord(account);

        showScreen('screen-dashboard');
        showSection('play');
    } catch (error) {
        console.error('[Microsoft Login]', error);
        showToast(`Error login Microsoft: ${error.message || error}`, 'error');
    }
}

// LOGIN
function login() {
    const user = document.getElementById('username').value.trim();
    if(user.length < 3) return alert("Nombre muy corto");
    
    document.getElementById('user-name').innerText = user;
    setUserAvatar(user, buildAvatarUrl(user));
    updateWelcomeMessage(user);
    updateDiscordStatus('En el menú');
    showScreen('screen-dashboard');
}

function updateDiscordStatus(status = 'En el menú') {
    const userName = document.getElementById('user-name')?.innerText?.trim() || 'Invitado';
    const selectedVersion = versionSeleccionada || '1.20.4';

    ipc.send('update-rpc', {
        user: userName,
        version: selectedVersion,
        status
    });
}

ipc.on('status', (e, msg) => {
    const launchStatus = document.getElementById('launch-status');
    const btnPlay = document.getElementById('btn-play-main');
    const launchScreen = document.getElementById('launch-screen');
    const playText = document.getElementById('play-button-text');

    if (launchStatus) {
        launchStatus.innerText = msg;
    }

    if (btnPlay && (String(msg).includes('Error') || String(msg).includes('cerrado'))) {
        btnPlay.disabled = false;
        btnPlay.innerText = 'JUGAR';
    }

    if (launchScreen && (String(msg).includes('Error') || String(msg).includes('cerrado'))) {
        launchScreen.classList.add('hidden');
    }

    if (String(msg).includes('¡Juego Iniciado!') || String(msg).includes('¡Lanzando Minecraft!')) {
        updateDiscordStatus('Jugando');
    }
});

ipc.on('game-closed', (_event, data) => {
    const launchScreen = document.getElementById('launch-screen');
    const launchStatus = document.getElementById('launch-status');
    const btnPlay = document.getElementById('btn-play-main');
    const playText = document.getElementById('play-button-text');

    if (launchScreen) {
        launchScreen.classList.add('hidden');
    }

    if (launchStatus) {
        launchStatus.innerText = `Minecraft cerrado (código ${data?.code ?? '0'})`;
    }

    if (btnPlay) {
        btnPlay.disabled = false;
    }

    if (playText) {
        playText.innerText = 'JUGAR';
    }
});

ipc.on('game-crash', (event, data) => {
    const statusElement = document.getElementById('launch-status');
    const btnPlay = document.getElementById('btn-play-main');

    if (btnPlay) {
        btnPlay.disabled = false;
        btnPlay.innerText = 'JUGAR';
    }

    if (statusElement) {
        statusElement.innerHTML = `
            <div style="color: #ff5555; background: rgba(0,0,0,0.5); padding: 10px; border-radius: 5px; text-align: left; font-family: monospace; font-size: 12px; margin-top: 10px;">
                <strong>⚠️ EL JUEGO CRASHEÓ (Código ${data.code})</strong><br>
                <small>Posible causa detectada en los logs:</small>
                <pre style="white-space: pre-wrap; margin-top: 5px; max-height: 100px; overflow-y: auto;">${data.logs}</pre>
            </div>
        `;
    }

    showToast('El juego se cerró de forma inesperada');
});

// CAPTURAS DE PANTALLA REALES
async function loadScreenshots() {
    changeTab('capturas');
    const modal = document.getElementById('screenshot-modal');
    const grid = document.getElementById('screenshot-grid');
    const tip = document.getElementById('screenshot-tip');

    if (modal) modal.classList.remove('hidden');
    if (grid) grid.innerHTML = "Cargando...";
    if (tip) tip.innerText = 'Haz clic en una miniatura para verla en grande y copiar la imagen.';

    const files = await ipc.invoke('get-screenshots');

    if (!grid) return;
    grid.innerHTML = "";

    if (files.length === 0) {
        grid.innerHTML = "<p class='empty-text'>No se encontraron capturas en el launcher.</p>";
        return;
    }

    files.forEach(path => {
        const item = document.createElement('div');
        item.className = 'screenshot-item';

        const img = document.createElement('img');
        img.src = `file://${path}`;
        img.alt = path;

        item.appendChild(img);

        item.addEventListener('click', () => {
            openScreenshot(path);
        });

        grid.appendChild(item);
    });
}

let currentSSPath = '';

// para el menú de capturas y servidores
function openScreenshots() {
    showSection('screenshots');
}

function openScreenshot(path) {
    currentSSPath = path;
    const modal = document.getElementById('screenshot-detail-modal');
    const img = document.getElementById('ss-full-image');
    const name = document.getElementById('ss-filename');

    if (!modal || !img || !name) return;

    img.src = `file://${path}`;
    name.innerText = path.split(/[\\/]/).pop();
    modal.classList.remove('hidden');
}

function closeSSDetail() {
    const modal = document.getElementById('screenshot-detail-modal');
    if (!modal) return;
    modal.classList.add('hidden');
}

function closeScreenshotModal() {
    const modal = document.getElementById('screenshot-modal');
    if (!modal) return;
    modal.classList.add('hidden');
}

function showToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    container.innerHTML = '';

    const toast = document.createElement('div');
    toast.className = 'toast';

    const text = document.createElement('span');
    text.className = 'toast-message';
    text.innerText = message;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'toast-close';
    closeBtn.setAttribute('aria-label', 'Cerrar notificación');
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => toast.remove());

    toast.appendChild(text);
    toast.appendChild(closeBtn);
    container.appendChild(toast);
}

function renderUpdateNotification({ state = 'checking', message = 'Buscando actualizaciones...', percent = 0 } = {}) {
    const notification = document.getElementById('update-notification');
    const messageNode = document.getElementById('update-message');
    const progressBar = document.getElementById('update-progress');
    const progressFill = document.getElementById('update-progress-fill');
    const installButton = document.getElementById('update-install-button');

    if (!notification || !messageNode || !progressBar || !progressFill || !installButton) return;

    messageNode.innerText = message;
    notification.classList.remove('hidden');

    if (state === 'downloading' || state === 'available' || state === 'checking') {
        progressBar.classList.remove('hidden');
        progressFill.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
    } else {
        progressBar.classList.add('hidden');
        progressFill.style.width = '0%';
    }

    if (state === 'downloaded') {
        installButton.classList.remove('hidden');
    } else {
        installButton.classList.add('hidden');
    }

    if (state === 'none') {
        setTimeout(() => notification.classList.add('hidden'), 3200);
    }
}

ipc.on('update-status', (_event, payload = {}) => {
    renderUpdateNotification(payload);

    if (payload.state === 'downloaded') {
        showToast('Actualización lista para instalar');
    }
});

const updateCloseButton = document.getElementById('update-close-button');
if (updateCloseButton) {
    updateCloseButton.addEventListener('click', () => {
        document.getElementById('update-notification')?.classList.add('hidden');
    });
}

const updateInstallButton = document.getElementById('update-install-button');
if (updateInstallButton) {
    updateInstallButton.addEventListener('click', () => {
        ipc.send('restart_app');
    });
}

function copySSImage() {
    if (!currentSSPath) {
        showToast('No hay captura seleccionada.', 1600);
        return;
    }

    try {
        const image = nativeImage.createFromPath(currentSSPath);
        if (image.isEmpty()) {
            throw new Error('No se pudo cargar la captura.');
        }

        clipboard.writeImage(image);

        const tip = document.getElementById('screenshot-tip');
        if (tip) tip.innerText = 'Captura copiada al portapapeles correctamente.';
        showToast('Imagen copiada al portapapeles', 1800);
    } catch (e) {
        console.error('Error copiando la captura:', e);
        const tip = document.getElementById('screenshot-tip');
        if (tip) tip.innerText = 'No se pudo copiar la imagen al portapapeles.';
        showToast('Error al copiar la imagen', 1800);
    }
}

function stopServerRefresh() {
    if (serverRefreshInterval) {
        clearInterval(serverRefreshInterval);
        serverRefreshInterval = null;
    }
}

function escapeHtml(value = '') {
    return String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[char]);
}

function cleanServerText(value = '', fallback = '') {
    const cleaned = String(value || '')
        .replace(/§[0-9A-FK-OR]/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

    return cleaned || fallback;
}

function getLatencyClass(ms) {
    if (ms === null || ms === undefined || Number.isNaN(ms)) return 'offline';
    if (ms < 100) return 'good';
    if (ms < 200) return 'medium';
    return 'bad';
}

function renderServerCards(servers) {
    const list = document.getElementById('server-list');
    if (!list) return;

    const checkedAt = new Date().toLocaleTimeString('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });

    list.innerHTML = `
        <div class="server-list-note">
            <i class="fa-solid fa-signal"></i> Estado actualizado automáticamente cada 30 segundos · Última revisión ${checkedAt}
        </div>
        ${servers.map((server) => {
            const online = Boolean(server.online);
            const displayName = cleanServerText(server.name, 'Servidor');
            const displayIp = cleanServerText(server.ip, 'Sin IP');
            const displayVersion = cleanServerText(server.version, 'Desconocida');
            const latency = typeof server.latency === 'number' ? `${server.latency} ms` : '-- ms';
            const players = online ? `${server.playersOnline}/${server.playersMax} jugadores` : 'Sin respuesta';
            const motd = online
                ? cleanServerText(server.motd, 'Servidor disponible.')
                : cleanServerText(server.error || server.motd, 'Servidor desconectado o inaccesible.');

            return `
                <div class="server-card ${online ? 'is-online' : 'is-offline'}">
                    <div class="server-card-top">
                        <div>
                            <div class="server-name">${escapeHtml(displayName)}</div>
                            <div class="server-ip">${escapeHtml(displayIp)}</div>
                        </div>
                        <div class="server-badges">
                            <span class="server-pill ${online ? 'online' : 'offline'}">${online ? 'ONLINE' : 'OFFLINE'}</span>
                            <span class="latency-badge ${getLatencyClass(server.latency)}">${latency}</span>
                        </div>
                    </div>
                    <div class="server-meta">
                        <span><i class="fa-solid fa-users"></i> ${escapeHtml(players)}</span>
                        <span><i class="fa-solid fa-cube"></i> ${escapeHtml(displayVersion)}</span>
                    </div>
                    <div class="server-motd">${escapeHtml(motd)}</div>
                </div>
            `;
        }).join('')}
    `;
}

async function refreshServerList() {
    const list = document.getElementById('server-list');
    if (!list || activeSection !== 'servers') return;

    list.innerHTML = '<p class="empty-text">Cargando lista de servidores...</p>';

    try {
        const servers = await ipc.invoke('get-servers');
        if (activeSection !== 'servers') return;

        if (!servers || servers.length === 0) {
            list.innerHTML = '<p class="empty-text">No se encontraron servidores disponibles.</p>';
            return;
        }

        renderServerCards(servers);

        const enrichedServers = await Promise.all(
            servers.map(async (server) => {
                try {
                    return await ipc.invoke('get-server-status', server);
                } catch (error) {
                    console.error('No se pudo consultar el estado de un servidor:', error);
                    return server;
                }
            })
        );

        if (activeSection !== 'servers') return;
        renderServerCards(enrichedServers);
    } catch (error) {
        if (activeSection !== 'servers') return;
        console.error('No se pudo actualizar la lista de servidores:', error);
        list.innerHTML = '<p class="empty-text">No se pudo consultar el estado de los servidores.</p>';
    }
}

async function openServers() {
    activeSection = 'servers';
    changeTab('servers');
    document.getElementById('ss-grid').innerHTML = '';
    const list = document.getElementById('server-list');
    if (!list) return;

    stopServerRefresh();
    await refreshServerList();
    serverRefreshInterval = setInterval(() => {
        if (activeSection === 'servers') {
            refreshServerList();
        }
    }, 30000);
}

document.addEventListener('click', (event) => {
    const accountModal = document.getElementById('account-modal');
    if (accountModal && !accountModal.classList.contains('hidden') && event.target === accountModal) {
        closeAccountModal();
    }
});

// Play button is handled in DOMContentLoaded (lanzarJuego)
// Version selection UI is handled by renderVersionsUI and versionSeleccionada global.

function loadStatusBar() {
    // Obtener país (API principal + fallback offline)
    async function obtenerPais() {
        const countryElem = document.getElementById('country-text');
        if (!countryElem) return;

        const cachedCountry = localStorage.getItem(COUNTRY_CACHE_KEY);
        countryElem.innerText = cachedCountry || t('gettingCountry');
        updateLanguageRegionPreview();

        async function fetchCountry(url) {
            const response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        }

        function applyCountry(countryName) {
            const finalCountry = countryName || cachedCountry || guessCountryOffline() || t('notAvailable');
            countryElem.innerText = finalCountry;

            const countryPreview = document.getElementById('region-country-preview');
            if (countryPreview) {
                countryPreview.innerText = finalCountry;
            }

            updateLanguageRegionPreview();

            if (countryName) {
                localStorage.setItem(COUNTRY_CACHE_KEY, countryName);
            }
        }

        if (!navigator.onLine) {
            applyCountry(cachedCountry || guessCountryOffline());
            return;
        }

        try {
            const data = await fetchCountry('https://ipapi.co/json/');
            applyCountry(data.country_name || data.country || 'Desconocido');
            return;
        } catch (error1) {
            console.warn('ipapi falló:', error1);
        }

        try {
            const data = await fetchCountry('https://ipwhois.app/json/');
            applyCountry(data.country || data.country_name || 'Desconocido');
            return;
        } catch (error2) {
            console.warn('ipwhois fallo:', error2);
        }

        applyCountry(cachedCountry || guessCountryOffline());
    }

    obtenerPais();
    window.addEventListener('online', obtenerPais);
    window.addEventListener('offline', obtenerPais);

    // Actualizar hora cada segundo
    function actualizarReloj() {
        const ahora = new Date();
        const opciones = { hour: '2-digit', minute: '2-digit', second: '2-digit' };
        const localeMap = { es: 'es-ES', en: 'en-US', pt: 'pt-BR', fr: 'fr-FR' };
        const horaFormateada = ahora.toLocaleTimeString(localeMap[getCurrentLanguage()] || 'es-ES', opciones);
        document.getElementById('time-text').innerText = horaFormateada;
    }

    actualizarReloj();
    setInterval(actualizarReloj, 1000);
}

// loadStatusBar() is called in DOMContentLoaded to ensure DOM elements exist

function openSettings() {
    showSection('settings');
}

function applyColor() {
    if (tempSelectedHex) {
        applyPaletteColor();
        return;
    }

    const colorPicker = document.getElementById('color-picker');
    if (!colorPicker) return;

    setLauncherAccent(colorPicker.value);
    localStorage.setItem('azureAccentColor', colorPicker.value);
    localStorage.setItem('themeColor', colorPicker.value);
    localStorage.setItem('launcher-accent', colorPicker.value);
    showToast(`Color aplicado: ${colorPicker.value}`, 1400);
}

function setLauncherAccent(color) {
    if (!color || !/^#[0-9A-F]{6}$/i.test(color)) return;

    document.documentElement.style.setProperty('--accent', color);
    document.documentElement.style.setProperty('--accent-blue', color);

    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);

    document.documentElement.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
    document.documentElement.style.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.28)`);
    document.documentElement.style.setProperty('--accent-strong', `rgba(${r}, ${g}, ${b}, 0.92)`);

    const auroraBg = document.querySelector('.aurora-bg');
    if (auroraBg) {
        auroraBg.style.background = `linear-gradient(45deg, rgba(${r}, ${g}, ${b}, 0.18), rgba(${r}, ${g}, ${b}, 0.38), ${color}, rgba(${r}, ${g}, ${b}, 0.12))`;
        auroraBg.style.backgroundSize = '400% 400%';
    }

    const luminosity = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const textColor = luminosity > 0.5 ? '#000000' : '#ffffff';
    document.documentElement.style.setProperty('--text-color', textColor);
}

function applyLanguage() {
    const selector = document.getElementById('language-select-new') || document.getElementById('language-select');
    if (!selector) return;

    const selected = selector.value;
    localStorage.setItem('azureLanguage', selected);
    localStorage.setItem('launcherLang', selected);
    applyTranslations(selected);
    showToast(`${t('applyLanguageBtn', selected)}: ${selected.toUpperCase()}`, 1600);
}

// FUNCIONES PARA TOP SERVIDORES REALES
function registrarEntradaServidor(ip) {
    if (!ip) return;

    let stats = JSON.parse(localStorage.getItem('azure_stats_servers') || '{}');
    if (!stats[ip]) stats[ip] = { clics: 0, oculto: false };
    stats[ip].clics += 1;
    localStorage.setItem('azure_stats_servers', JSON.stringify(stats));

    localStorage.setItem('last_server', ip);
    if (firebaseReady) updateMyPresence();

    actualizarTopUI();
}

function actualizarTopUI() {
    let stats = JSON.parse(localStorage.getItem('azure_stats_servers') || '{}');
    const top3 = Object.keys(stats)
        .map(ip => ({ ip, ...stats[ip] }))
        .filter(s => !s.oculto)
        .sort((a, b) => b.clics - a.clics)
        .slice(0, 3);

    const container = document.getElementById('top-servers-list');
    if (!container) return;

    container.innerHTML = top3.map((s, index) => `
        <div class="top-server-item">
            <span class="rank">#${index + 1}</span>
            <span class="ip">${escapeHtml(s.ip)}</span>
            <span class="count">${s.clics} entradas</span>
            <button onclick="ocultarServidorDelTop('${escapeHtml(s.ip)}')" title="Ocultar de mi Top">
                <i class="fa-solid fa-eye-slash"></i>
            </button>
        </div>
    `).join('');
}

function ocultarServidorDelTop(ip) {
    let stats = JSON.parse(localStorage.getItem('azure_stats_servers') || '{}');
    if (stats[ip]) {
        stats[ip].oculto = true;
        localStorage.setItem('azure_stats_servers', JSON.stringify(stats));
        actualizarTopUI();
        showToast('Privacidad', 'Servidor ocultado del Top.', 'info');
    }
}

function obtenerTopServidoresReales() {
    let stats = JSON.parse(localStorage.getItem('azure_stats_servers') || '{}');
    return Object.keys(stats)
        .filter(ip => !stats[ip].oculto)
        .map(ip => ({ ip, clics: stats[ip].clics }))
        .sort((a, b) => b.clics - a.clics)
        .slice(0, 3);
}

// FUNCIONES PARA TRANSFERENCIAS
function aceptarTransferencia(id, tipo, contenido) {
    if (tipo === 'ip') {
        // Añadir IP a tu lista de servidores locales
        agregarServidorLocal(contenido);
        showToast('Servidor', 'IP añadida a tus servidores', 'success');
    } else if (tipo === 'captura') {
        // Lógica para guardar o ver la captura
        showToast('Captura', 'Captura recibida', 'success');
    }
    rechazarTransferencia(id); // Borramos del buzón después de aceptar
}

function rechazarTransferencia(id) {
    const myId = cleanFriendKey(getLinkedIdentity());
    firebaseFns.remove(firebaseFns.ref(firebaseDb, `transferencias/${myId}/${id}`));
}

// FUNCIONES PARA CAPTURA FAVORITA
function establecerCapturaFavorita() {
    const rutaImagen = document.getElementById('ss-full-image').src;
    
    // 1. Guardar localmente
    localStorage.setItem('azure_fav_screenshot', rutaImagen);
    
    // 2. Subir a Firebase (Para que tus amigos la vean)
    const miTag = document.getElementById('user-name').innerText;
    if (miTag && miTag !== 'Usuario' && firebaseDb) {
        const miRuta = cleanFriendKey(miTag);
        
        // Creamos una sección 'perfiles' en la base de datos
        firebaseFns.update(firebaseFns.ref(firebaseDb, `perfiles/${miRuta}`), {
            capturaFavorita: rutaImagen,
            actualizado: Date.now()
        }).then(() => {
            showToast('Perfil', '¡Captura favorita actualizada!', 'success');
        });
    } else {
        showToast('Perfil', 'Captura guardada localmente', 'success');
    }
}

// FUNCIONES AUXILIARES
function showConfirmModal(title, message, type = 'default') {
    return new Promise((resolve) => {
        const modal = document.getElementById('custom-confirm');
        const titleElem = document.getElementById('confirm-title');
        const messageElem = document.getElementById('confirm-message');
        const acceptBtn = document.getElementById('btn-confirm-accept');
        const cancelBtn = document.getElementById('btn-confirm-cancel') || document.querySelector('#custom-confirm .btn-cancel');

        if (!modal || !titleElem || !messageElem || !acceptBtn || !cancelBtn) {
            resolve(confirm(message));
            return;
        }

        titleElem.innerText = title;
        messageElem.innerText = message;

        if (type === 'danger') {
            acceptBtn.classList.add('btn-danger');
        } else {
            acceptBtn.classList.remove('btn-danger');
        }

        modal.classList.remove('hidden');

        const handleAccept = () => {
            modal.classList.add('hidden');
            acceptBtn.removeEventListener('click', handleAccept);
            cancelBtn.removeEventListener('click', handleCancel);
            resolve(true);
        };

        const handleCancel = () => {
            modal.classList.add('hidden');
            acceptBtn.removeEventListener('click', handleAccept);
            cancelBtn.removeEventListener('click', handleCancel);
            resolve(false);
        };

        acceptBtn.addEventListener('click', handleAccept);
        cancelBtn.addEventListener('click', handleCancel);
    });
}

function requestTransfer(type) {
    // Función para solicitar transferencia
    if (type === 'ip') {
        const ip = prompt('Ingresa la IP del servidor a transferir:');
        if (ip) {
            // Lógica para enviar IP
            showToast('Transferencia', 'Función no implementada aún', 'info');
        }
    } else if (type === 'capture') {
        // Lógica para enviar captura
        showToast('Transferencia', 'Función no implementada aún', 'info');
    }
}

// --- FUNCIONES DE VERSIONES ---
async function loadInstalledVersions() {
    const versionSelect = document.getElementById('version-select'); // Asegúrate que este ID existe en tu HTML
    if (!versionSelect) return;

    const versions = await ipc.invoke('get-local-versions');
    
    if (!Array.isArray(versions) || versions.length === 0) {
        versionSelect.innerHTML = '<option value="">No hay versiones instaladas</option>';
    } else {
        versionSelect.innerHTML = versions.map(v => 
            `<option value="${v}">${getVersionLabel(v)}</option>`
        ).join('');
    }
}

async function renderVersionsUI() {
    const container = document.getElementById('versions-container');
    if (!container) return;

    const installedVersions = await ipc.invoke('get-local-versions');
    const merged = getMergedVersionItems(installedVersions || []);

    container.innerHTML = '';

    const addItem = document.createElement('div');
    addItem.className = 'version-item';

    const addInfo = document.createElement('div');
    addInfo.className = 'version-info';
    addInfo.style.cssText = 'flex-direction: row; align-items: center; gap: 10px;';
    addInfo.innerHTML = '<i class="fa-solid fa-plus" style="color:#4ecdc4"></i><span class="version-alias">Crear instalación</span>';

    const addButton = document.createElement('button');
    addButton.className = 'btn-tuerca';
    addButton.type = 'button';
    addButton.title = 'Crear instalación';
    addButton.innerHTML = '<i class="fa-solid fa-plus"></i>';
    addButton.addEventListener('click', (event) => {
        event.stopPropagation();
        openSkModal(null);
    });

    addItem.appendChild(addInfo);
    addItem.appendChild(addButton);
    addItem.addEventListener('click', () => openSkModal(null));
    container.appendChild(addItem);

    merged.forEach((item) => {
        const div = document.createElement('div');
        div.className = 'version-item';

        const profile = getVersionProfile(item.version) || versionProfiles.find(p => p.id === item.id);
        const iconPath = profile?.icon || 'Azure-Launcher.png';
        const resolvedIcon = String(iconPath).startsWith('data:') || String(iconPath).startsWith('http')
            ? iconPath
            : `file://${iconPath}`;

        const leftGroup = document.createElement('div');
        leftGroup.style.cssText = 'display:flex; align-items: center; gap: 12px;';

        const iconImg = document.createElement('img');
        iconImg.src = resolvedIcon;
        iconImg.className = 'version-icon-clickable';
        iconImg.title = 'Cambiar icono';
        iconImg.alt = 'Icono';
        iconImg.style.cssText = 'width: 36px; height: 36px; object-fit: cover; border-radius: 8px; border: 1px solid rgba(255,255,255,0.12); cursor: pointer;';
        iconImg.addEventListener('click', (event) => {
            event.stopPropagation();
            openIconSelectorModal(item.id);
        });

        const infoWrapper = document.createElement('div');
        infoWrapper.className = 'version-info';
        infoWrapper.style.cssText = 'flex-direction: column; align-items: flex-start;';

        const aliasSpan = document.createElement('span');
        aliasSpan.className = 'version-alias';
        aliasSpan.textContent = item.alias;

        const versionSpan = document.createElement('span');
        versionSpan.className = 'version-real';
        versionSpan.textContent = `Versión: ${item.version} ${item.installed ? '' : '(descargar)'}`;

        infoWrapper.appendChild(aliasSpan);
        infoWrapper.appendChild(versionSpan);
        leftGroup.appendChild(iconImg);
        leftGroup.appendChild(infoWrapper);

        const actionGroup = document.createElement('div');
        actionGroup.style.cssText = 'display:flex; gap: 6px;';

        const editButton = document.createElement('button');
        editButton.className = 'btn-tuerca';
        editButton.type = 'button';
        editButton.title = 'Editar instalación';
        editButton.innerHTML = '<i class="fa-solid fa-gear"></i>';
        editButton.addEventListener('click', (event) => {
            event.stopPropagation();
            openSkModal(item.id);
        });

        const deleteButton = document.createElement('button');
        deleteButton.className = 'btn-tuerca';
        deleteButton.type = 'button';
        deleteButton.title = 'Eliminar instalación';
        deleteButton.innerHTML = '<i class="fa-solid fa-trash"></i>';
        deleteButton.addEventListener('click', (event) => {
            event.stopPropagation();
            deleteProfile(item.id);
        });

        actionGroup.appendChild(editButton);
        actionGroup.appendChild(deleteButton);

        div.appendChild(leftGroup);
        div.appendChild(actionGroup);
        div.addEventListener('click', () => {
            document.querySelectorAll('.version-item').forEach((el) => el.classList.remove('active'));
            div.classList.add('active');

            versionSeleccionada = item.version;
            const playText = document.getElementById('play-button-text');
            if (playText) playText.innerText = `JUGAR ${item.alias}`;

            showToast('Azure', `Seleccionado ${item.alias}`, 'info');
        });

        container.appendChild(div);
    });
}

async function openSkModal(profileId = null) {
    const select = document.getElementById('sk-select-version');
    const nameInput = document.getElementById('sk-input-name');
    const title = document.getElementById('sk-modal-title');
    const deleteBtn = document.getElementById('sk-delete-btn');

    if (!select || !nameInput || !title || !deleteBtn) return;

    const localVersions = await ipc.invoke('get-local-versions');
    select.innerHTML = '';

    if (!Array.isArray(localVersions) || localVersions.length === 0) {
        select.innerHTML = '<option value="" disabled selected>No hay versiones instaladas</option>';
    } else {
        localVersions.forEach(v => {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v;
            select.appendChild(opt);
        });
    }

    if (profileId) {
        const profile = getVersionProfileByIdentifier(profileId);
        if (profile) {
            currentEditId = profile.id;
            title.innerText = 'Editar Instalación';
            nameInput.value = profile.alias || profile.version || '';
            deleteBtn.classList.remove('hidden');

            if (profile.version && Array.from(select.options).find(opt => opt.value === profile.version)) {
                select.value = profile.version;
            }
        } else {
            currentEditId = null;
            title.innerText = 'Nueva Instalación';
            nameInput.value = profileId;
            deleteBtn.classList.add('hidden');

            if (Array.from(select.options).find(opt => opt.value === profileId)) {
                select.value = profileId;
            }
        }
    } else {
        currentEditId = null;
        title.innerText = 'Nueva Instalación';
        nameInput.value = '';
        deleteBtn.classList.add('hidden');
    }

    document.getElementById('sk-modal').classList.remove('hidden');
}

function getVersionProfileByIdentifier(identifier) {
    return versionProfiles.find(p => p.id === identifier) || versionProfiles.find(p => p.version === identifier);
}

function ensureVersionProfileByIdentifier(identifier) {
    let profile = getVersionProfileByIdentifier(identifier);
    if (profile) return profile;

    if (!identifier) return null;
    const newProfile = {
        id: `vp-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
        version: identifier,
        alias: identifier,
        hidden: false
    };
    versionProfiles.push(newProfile);
    saveVersionProfiles();
    return newProfile;
}

function openIconSelectorModal(profileId) {
    pendingIconProfileId = profileId;
    const grid = document.getElementById('icon-selector-grid');
    const modal = document.getElementById('sk-modal-icon-selector');

    if (!grid || !modal) return;
    grid.innerHTML = '';

    const uploadCard = document.createElement('div');
    uploadCard.className = 'screenshot-item';
    uploadCard.style.minHeight = '60px';
    uploadCard.style.display = 'flex';
    uploadCard.style.alignItems = 'center';
    uploadCard.style.justifyContent = 'center';
    uploadCard.style.cursor = 'pointer';
    uploadCard.style.background = 'rgba(255,255,255,0.04)';
    uploadCard.style.border = '1px dashed rgba(255,255,255,0.16)';
    uploadCard.style.borderRadius = '10px';
    uploadCard.innerHTML = '<i class="fa-solid fa-plus" style="font-size: 20px; color: #4ecdc4;"></i>';
    uploadCard.title = 'Agregar icono personalizado (128x128)';
    uploadCard.addEventListener('click', () => seleccionarIconoCustom(profileId));
    grid.appendChild(uploadCard);

    STANDARD_MINECRAFT_BLOCKS.forEach((block) => {
        const item = document.createElement('div');
        item.className = 'screenshot-item';
        item.style.minHeight = '60px';
        item.style.padding = '4px';
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.justifyContent = 'center';
        item.style.cursor = 'pointer';

        const img = document.createElement('img');
        img.src = block.path;
        img.alt = block.name;
        img.title = block.name;
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'contain';
        img.style.borderRadius = '8px';
        img.onerror = () => {
            img.src = 'Azure-Launcher.png';
        };

        item.appendChild(img);
        item.addEventListener('click', () => selectProfileIcon(block.path));
        grid.appendChild(item);
    });

    modal.classList.remove('hidden');
}

function closeIconSelectorModal() {
    const modal = document.getElementById('sk-modal-icon-selector');
    if (modal) modal.classList.add('hidden');
    pendingIconProfileId = null;
}

function selectProfileIcon(iconPath) {
    if (!pendingIconProfileId) return;

    const profile = ensureVersionProfileByIdentifier(pendingIconProfileId);
    if (!profile) return;

    profile.icon = iconPath;
    saveVersionProfiles();
    renderVersionsUI();
    showToast('Perfil', 'Icono actualizado correctamente', 'success');
    closeIconSelectorModal();
}

async function uploadCustomProfileIcon(profileId) {
    if (!profileId) return;
    closeIconSelectorModal();

    const imageDataUrl = await ipc.invoke('upload-custom-skin', profileId);
    if (!imageDataUrl) return;

    const image = new Image();
    const loaded = new Promise((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('No se pudo cargar la imagen'));
    });
    image.src = imageDataUrl;

    try {
        await loaded;
    } catch (err) {
        showToast('Error', 'No se pudo cargar el icono.', 'error');
        return;
    }

    if (image.width > 128 || image.height > 128) {
        showToast('Error', 'Icono demasiado grande. Máximo 128x128 píxeles.', 'error');
        return;
    }

    const profile = ensureVersionProfileByIdentifier(profileId);
    if (!profile) return;

    profile.icon = imageDataUrl;
    saveVersionProfiles();
    renderVersionsUI();
    showToast('Perfil', 'Icono personalizado guardado.', 'success');
}

function guardarEdicionVersion(versionId, nuevoAlias, estaOculta) {
    if (!versionId) {
        showToast('Error: No se seleccionó ninguna versión.');
        return;
    }

    let profile = versionProfiles.find(p => p.id === versionId || p.version === versionId);

    if (!profile) {
        profile = {
            id: `vp-${Date.now()}`,
            version: versionId,
            alias: nuevoAlias || versionId,
            hidden: estaOculta || false
        };
        versionProfiles.push(profile);
    } else {
        profile.alias = nuevoAlias || profile.version;
        profile.hidden = !!estaOculta;
    }

    saveVersionProfiles();
    renderVersionsUI();
    showToast('¡Versión actualizada correctamente!');
}

function seleccionarIconoCustom(versionId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png, image/jpeg, image/jpg';

    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            const base64Icon = event.target.result;
            if (!base64Icon) return;

            let profile = versionProfiles.find(p => p.id === versionId || p.version === versionId);
            if (!profile) {
                profile = {
                    id: `vp-${Date.now()}`,
                    version: versionId,
                    alias: versionId,
                    hidden: false
                };
                versionProfiles.push(profile);
            }

            profile.icon = base64Icon;
            saveVersionProfiles();
            renderVersionsUI();
            showToast('¡Icono personalizado guardado!');
        };
        reader.readAsDataURL(file);
    };

    input.click();
}

function closeSkModal() {
    document.getElementById('sk-modal').classList.add('hidden');
    currentEditId = null;
}

function closeEditModal() {
    const modal = document.getElementById('edit-profile-modal');
    if (modal) modal.classList.add('hidden');
    currentEditId = null;
}

function saveEditedProfile() {
    const alias = document.getElementById('edit-alias-input')?.value.trim() || '';
    const version = document.getElementById('edit-version-input')?.value.trim() || versionSeleccionada;
    const hidden = document.getElementById('edit-hidden-checkbox')?.checked || false;

    if (!version) {
        showToast('Error: Debes indicar la versión.');
        return;
    }

    guardarEdicionVersion(currentEditId || version, alias || version, hidden);
    closeEditModal();
}

function saveProfile() {
    const alias = document.getElementById('sk-input-name').value.trim();
    const version = document.getElementById('sk-select-version').value;

    if (!version) {
        alert('Selecciona una versión de Minecraft (local)');
        return;
    }

    if (currentEditId) {
        const index = versionProfiles.findIndex(p => p.id === currentEditId);
        if (index !== -1) {
            versionProfiles[index].alias = alias || version;
            versionProfiles[index].version = version;
            versionProfiles[index].hidden = false;
        }
    } else {
        versionProfiles.push({
            id: `vp-${Date.now()}`,
            alias: alias || version,
            version,
            hidden: false
        });
    }

    saveVersionProfiles();
    renderVersionsUI();
    closeSkModal();
}

function deleteProfile(id = null) {
    const targetId = id || currentEditId;
    if (!targetId) return;

    pendingDeleteVersionId = targetId;
    pendingDeleteIndex = null;
    pendingConfirmAction = () => {
        if (pendingDeleteVersionId) {
            versionProfiles = versionProfiles.filter(p => p.id !== pendingDeleteVersionId);
            saveVersionProfiles();
            renderVersionsUI();
            closeSkModal();
            pendingDeleteVersionId = null;
        }
    };

    const confirmTitle = document.querySelector('#custom-confirm h2');
    const confirmDesc = document.querySelector('#custom-confirm p');
    if (confirmTitle) confirmTitle.innerText = '¿Eliminar esta instalación?';
    if (confirmDesc) confirmDesc.innerText = '¿Deseas eliminar esta instalación de la lista? Esta acción no se puede deshacer.';

    const confirmPanel = document.getElementById('custom-confirm');
    if (!confirmPanel) {
        // Fallback mínimo
        if (confirm('¿Deseas eliminar esta instalación de la lista?')) {
            pendingConfirmAction?.();
        }
        return;
    }

    confirmPanel.classList.remove('hidden');
}


async function configurarJavaVersion(versionId) {
    const path = await ipc.invoke('select-java');
    if (path) {
        if (path.toLowerCase().includes('javaw.exe')) {
            localStorage.setItem(`java_path_${versionId}`, path);
            showToast(`Java para ${versionId} configurado correctamente`);
        } else {
            showToast('Error: Debes seleccionar el archivo javaw.exe');
        }
    }
}

function seleccionarYJugar(version) {
    // Ya no se usa, ahora es onclick directo
}

function lanzarJuego() {
    const usernameInput = document.getElementById('offline-name');
    let username = 'Jugador';

    if (currentAccount && currentAccount.name) {
        username = currentAccount.name;
    } else if (usernameInput && usernameInput.value.trim()) {
        username = usernameInput.value.trim();
    } else {
        const userNameDisplay = document.getElementById('user-name')?.innerText?.trim();
        if (userNameDisplay && userNameDisplay.toLowerCase() !== 'usuario') {
            username = userNameDisplay;
        }
    }

    ipc.send('update-username', username);

    if (!versionSeleccionada) {
        showToast('Error', 'Por favor, selecciona una versión de la lista primero.', 'error');
        return;
    }

    // Deshabilitar el botón inmediatamente para evitar doble clic
    const btn = document.getElementById('btn-play-main');
    if (btn) {
        btn.disabled = true;
        const text = document.getElementById('play-button-text');
        if (text) text.innerText = 'INICIANDO...';
    }

    // 1. PRIORIDAD: ¿Tiene Java esta versión? Si no, ¿Tiene el global? Si no, "java"
    const javaVersion = localStorage.getItem(`java_path_${versionSeleccionada}`);
    const javaGlobal = localStorage.getItem('custom_java_path');
    const javaInput = document.getElementById('java-path-input') || {}; // Ajusta si tienes un input para Java
    const finalJavaPath = javaVersion || javaGlobal || javaInput.value || "java";

    console.log(`Iniciando ${versionSeleccionada} con ${finalJavaPath}`);

    // Enviar al main.js para iniciar con auth data
    const ramValue = document.getElementById('ram-input') ? document.getElementById('ram-input').value : 4;

    // Mostrar la pantalla de lanzamiento mientras Java se prepara
    const launchScreen = document.getElementById('launch-screen');
    const launchStatus = document.getElementById('launch-status');
    const launchBar = document.getElementById('launch-bar-fill');
    if (launchScreen) launchScreen.classList.remove('hidden');
    if (launchStatus) launchStatus.innerText = 'Preparando motores...';
    if (launchBar) launchBar.style.width = '0%';

    const authPayload = currentAccount && currentAccount.type === 'premium' && currentAccount.accessToken
        ? {
            type: 'premium',
            name: currentAccount.name,
            uuid: currentAccount.uuid,
            accessToken: currentAccount.accessToken
        }
        : null;

    ipc.send('launch-game', {
        username: username,
        version: versionSeleccionada,
        javaPath: finalJavaPath,
        ram: ramValue,
        auth: authPayload
    });
}

// Escucha progreso de descarga desde main
ipc.on('launch-progress', (_event, data) => {
    const bar = document.getElementById('launch-bar-fill');
    const statusText = document.getElementById('launch-status');
    const screen = document.getElementById('launch-screen');

    if (screen && screen.classList.contains('hidden')) {
        screen.classList.remove('hidden');
    }

    if (bar && typeof data?.percent === 'number') {
        bar.style.width = `${Math.max(0, Math.min(100, data.percent))}%`;
    }

    if (statusText) {
        const label = data?.type ? `Descargando ${data.type}` : 'Descargando';
        statusText.innerText = `${label}: ${Math.max(0, Math.min(100, data.percent || 0))}%`;
    }
});

ipc.on('launch-finished', () => {
    const statusText = document.getElementById('launch-status');
    const bar = document.getElementById('launch-bar-fill');
    const screen = document.getElementById('launch-screen');

    if (bar) bar.style.width = '100%';
    if (statusText) statusText.innerText = '¡Listo! Iniciando aventura...';

    setTimeout(() => {
        // Cerramos/ocultamos la pantalla solo en UI despues de cargar al 100%
        if (screen) screen.classList.add('hidden');

        const btn = document.getElementById('btn-play-main');
        if (btn) btn.disabled = false;
        const playText = document.getElementById('play-button-text');
        if (playText) playText.innerText = '¡JUGAR AHORA!';
    }, 900);
});

ipc.on('launch-error', (_event, data) => {
    const statusText = document.getElementById('launch-status');
    const screen = document.getElementById('launch-screen');
    const bar = document.getElementById('launch-bar-fill');
    if (statusText) statusText.innerText = `Error: ${data?.message || 'Problema al iniciar'}`;
    if (bar) bar.style.width = '0%';

    setTimeout(() => {
        if (screen) screen.classList.add('hidden');
        const btn = document.getElementById('btn-play-main');
        if (btn) btn.disabled = false;
        const playText = document.getElementById('play-button-text');
        if (playText) playText.innerText = '¡JUGAR AHORA!';
    }, 1500);
});

// --- FUNCIONES DE AMIGOS ---
async function aceptarSolicitud(remitenteTag) {
    const myTag = localStorage.getItem('discord_user');
    const myKey = cleanKey(myTag);
    const friendKey = cleanKey(remitenteTag);

    try {
        // 1. Añadir a mi lista de amigos
        await window.fbUpdate(window.fbRef(firebaseDb, `amigos/${myKey}/${friendKey}`), { tag: remitenteTag, status: 'online' });
        // 2. Añadirme a su lista de amigos
        await window.fbUpdate(window.fbRef(firebaseDb, `amigos/${friendKey}/${myKey}`), { tag: myTag, status: 'online' });
        
        // --- CRÍTICO: BORRAR LA SOLICITUD PARA QUE DESAPAREZCA ---
        await window.fbRemove(window.fbRef(firebaseDb, `solicitudes/${myKey}/${friendKey}`));
        
        showToast('Azure', `¡Ahora eres amigo de ${remitenteTag}!`, 'success');
    } catch (e) {
        console.error("Error al aceptar:", e);
    }
}

// --- FUNCIONES DE PRIVACIDAD ---
async function setFavoriteCapture(url) {
    const myTag = localStorage.getItem('discord_user');
    if (!myTag) return;

    await window.fbUpdate(window.fbRef(firebaseDb, `perfiles/${cleanKey(myTag)}`), {
        favoriteCapture: url
    });
    showToast('Privacidad', 'Captura de perfil actualizada', 'success');
}

function toggleServerVisibility(ip) {
    let stats = JSON.parse(localStorage.getItem('azure_server_stats') || '{}');
    if (stats[ip]) {
        stats[ip].hidden = !stats[ip].hidden;
        localStorage.setItem('azure_server_stats', JSON.stringify(stats));
        renderizarTopServers(); // Refrescar la lista
    }
}

// --- CONFIGURACIÓN DE RAM ---
const ramInput = document.getElementById('ram-input');
if (ramInput) {
    // Cargar RAM guardada o dejar 4 por defecto
    const savedRam = localStorage.getItem('custom_ram');
    if (savedRam) {
        ramInput.value = savedRam;
    }

    // Guardar si el usuario lo cambia
    ramInput.addEventListener('change', () => {
        localStorage.setItem('custom_ram', ramInput.value);
    });
}

// --- CONFIGURACIÓN DEL NOMBRE DE USUARIO ---
const usernameInput = document.getElementById('offline-name');

if (usernameInput) {
    // Detectar cuando el usuario deja de escribir para actualizar Discord
    usernameInput.addEventListener('blur', () => {
        ipc.send('update-username', usernameInput.value);
    });
    
    // Opcional: Actualizar al presionar Enter
    usernameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            ipc.send('update-username', usernameInput.value);
        }
    });
}

// --- FUNCIONES ADICIONALES ---
async function finalizeAuth(userData) {
    // Actualizar UI
    // ... tu código para actualizar la UI

    const nombreReal = userData?.displayName || userData?.username || userData?.name || '';

    if (nombreReal) {
        localStorage.setItem('last_username', nombreReal);
        ipc.send('update-username', nombreReal);
        console.log('Sesión sincronizada con Discord:', nombreReal);
    }

    // Guardar discord_user
    localStorage.setItem('discord_user', userData?.tag || userData?.username || nombreReal);

    // Esto actualiza presencia en Firebase
    updateMyPresence();
}

async function registrarEntradaServidor(serverIp) {
    localStorage.setItem('last_server', serverIp);
    updateMyPresence();
}

// == EXPORTAR FUNCIONES GLOBALES A HTML ==
window.controlWindow = controlWindow;
window.showScreen = showScreen;
window.showSection = showSection;
// window.manejarSubidaDeSkin = manejarSubidaDeSkin; // ya está definida como window.manejarSubidaDeSkin en el bloque inicial
window.exportarSkinUsuario = exportarSkinUsuario;
window.restablecerSkinPredeterminada = restablecerSkinPredeterminada;
window.aplicarSkinEnCuenta = aplicarSkinEnCuenta;
window.openSkinFileDialog = openSkinFileDialog;
window.setClassicModel = setClassicModel;
window.setSlimModel = setSlimModel;
window.resetSkinView = resetSkinView;
window.applySkin = applySkin;
window.showConfirmModal = showConfirmModal;
window.openSettings = openSettings;
window.renderizarSkin3D = renderizarSkin3D;
window.saveSkinToLibrary = saveSkinToLibrary;

// 3. LOGICA AL INICIAR (Para que salgan las versiones primero)
document.addEventListener('DOMContentLoaded', () => {
    // Forzamos que la primera pantalla sea 'play'
    if (typeof showSection === 'function') {
        window.showSection('play');
    }

    // Si tienes una skin guardada, la cargamos en 3D
    const ultimaSkin = localStorage.getItem('last_skin_url');
    if (ultimaSkin && typeof window.renderizarSkin3D === 'function') {
        window.renderizarSkin3D(ultimaSkin);
    }
});
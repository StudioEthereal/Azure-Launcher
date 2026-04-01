const { ipcRenderer, clipboard, nativeImage } = require('electron');
const ipc = ipcRenderer;

let firebaseDb = null;
let firebaseFns = null;
let firebaseReady = false;
let friendsRealtimeUnsubs = [];
let activeFriendsIdentity = '';
let friendsPresenceInterval = null;
let cachedFriendsPresence = {};
const DEFAULT_FRIEND_SERVERS = ['play.azuremc.net', 'mc.hypixel.net', 'survival.latam.com'];
const FIREBASE_FRIENDS_CONFIG = {
    apiKey: 'AIzaSyCrNo2X1qyL5fs-daXIPGZVsC7mqiJqVRU',
    authDomain: 'azurelauncher.firebaseapp.com',
    databaseURL: 'https://azurelauncher-default-rtdb.firebaseio.com',
    projectId: 'azurelauncher',
    storageBucket: 'azurelauncher.firebasestorage.app',
    messagingSenderId: '77647179819',
    appId: '1:77647179819:web:7ace2a6365cd06a657ba6e'
};

try {
    const { initializeApp, getApps, getApp } = require('firebase/app');
    const { getDatabase, ref, set, onValue, remove, update } = require('firebase/database');

    const firebaseAppInstance = getApps().length ? getApp() : initializeApp(FIREBASE_FRIENDS_CONFIG);
    firebaseDb = getDatabase(firebaseAppInstance);
    firebaseFns = { ref, set, onValue, remove, update };
    firebaseReady = true;
} catch (error) {
    console.warn('Firebase no disponible en el renderer:', error?.message || error);
}

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

function normalizeAccount(account = {}) {
    const resolvedName = String(account.username || account.name || '').trim();
    if (!resolvedName) return null;

    return {
        username: resolvedName,
        name: resolvedName,
        type: account.type === 'premium' ? 'premium' : 'offline',
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
function controlWindow(action) {
    if (action === 'close') {
        window.close();
    } else if (action === 'min') {
        require('electron').ipcRenderer.send('window-control', 'min');
    } else if (action === 'max') {
        require('electron').ipcRenderer.send('window-control', 'max');
    }
}


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
        playTab: 'Jugar',
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
        unlinkConfirm: '¿Quieres desvincular tu cuenta de Discord?',
        unlinkSuccess: 'Cuenta de Discord desvinculada'
    },
    en: {
        welcome: 'Welcome to Azure Launcher!',
        welcomeUser: 'Welcome {name} to Azure Launcher!',
        loginTitle: 'SIGN IN',
        premiumTitle: 'Premium',
        premiumDesc: 'Microsoft account',
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
        unlinkConfirm: 'Do you want to unlink your Discord account?',
        unlinkSuccess: 'Discord account unlinked'
    },
    pt: {
        welcome: 'Bem-vindo ao Azure Launcher!',
        welcomeUser: 'Bem-vindo {name} ao Azure Launcher!',
        loginTitle: 'INICIAR SESSÃO',
        premiumTitle: 'Premium',
        premiumDesc: 'Conta Microsoft',
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
        unlinkConfirm: 'Deseja desvincular sua conta do Discord?',
        unlinkSuccess: 'Conta do Discord desvinculada'
    },
    fr: {
        welcome: 'Bienvenue sur Azure Launcher !',
        welcomeUser: 'Bienvenue {name} sur Azure Launcher !',
        loginTitle: 'SE CONNECTER',
        premiumTitle: 'Premium',
        premiumDesc: 'Compte Microsoft',
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
        unlinkConfirm: 'Voulez-vous délier votre compte Discord ?',
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

    loadAccounts();
    loadVersionList();
    updateDiscordStatus('En el menú');
    startFriendsRealtimeSync();

    setTimeout(() => {
        const accounts = getStoredAccounts();
        const autoLoginAccount = getAutoLoginAccount(accounts);

        if (autoLoginAccount) {
            selectAccount(autoLoginAccount, { closeModal: false, updateList: true });
            showScreen('screen-dashboard');
        } else if (accounts.length > 0) {
            renderAccountSelector();
            showScreen('screen-account-selector');
        } else {
            showScreen('screen-login-choice');
        }
    }, 2500);
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

let pendingDeleteIndex = null;

function openDeleteConfirm(index) {
    pendingDeleteIndex = index;
    const confirmPanel = document.getElementById('custom-confirm');
    if (!confirmPanel) return;
    confirmPanel.classList.remove('hidden');
}

function addAccountToStorage(newAcc) {
    const normalizedNewAccount = normalizeAccount(newAcc);
    if (!normalizedNewAccount) return null;

    const accounts = getStoredAccounts();
    const existingAccount = accounts.find((acc) => acc.name.toLowerCase() === normalizedNewAccount.name.toLowerCase());

    if (existingAccount) {
        return existingAccount;
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
    updateWelcomeMessage(storedAccount.name);
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

    return {
        nick: fallbackNick,
        avatar: document.getElementById('user-avatar')?.src || getCachedAvatar(fallbackNick) || createOfflineAvatar(fallbackNick),
        country: countryText && !/cargando/i.test(countryText)
            ? countryText
            : (localStorage.getItem(COUNTRY_CACHE_KEY) || guessCountryOffline() || t('unknown')),
        localTime: timeText || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        status: navigator.onLine ? 'online' : 'offline',
        topServers: DEFAULT_FRIEND_SERVERS.slice(0, 3),
        favCapture: ''
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

    const identityKey = cleanFriendKey(identity);
    if (activeFriendsIdentity === identityKey && friendsRealtimeUnsubs.length > 0) {
        syncPresenceToFirebase();
        return;
    }

    stopFriendsRealtimeSync();
    activeFriendsIdentity = identityKey;
    ensureFriendsPresenceHeartbeat();

    const { ref, onValue } = firebaseFns;

    friendsRealtimeUnsubs.push(onValue(ref(firebaseDb, `solicitudes/${identityKey}`), (snapshot) => {
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
    }));

    friendsRealtimeUnsubs.push(onValue(ref(firebaseDb, `amigos/${identityKey}`), (snapshot) => {
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
    }));

    friendsRealtimeUnsubs.push(onValue(ref(firebaseDb, 'presencia'), (snapshot) => {
        cachedFriendsPresence = snapshot.val() || {};
        const currentStore = getFriendsStore();
        const mergedPending = currentStore.pendingRequests.map((friend) => enrichFriendEntry(friend));
        const mergedFriends = currentStore.friends.map((friend) => enrichFriendEntry(friend));
        saveSyncedFriendsStore(mergedPending, mergedFriends);
        if (activeSection === 'friends') renderFriendsPanel();
    }));

    syncPresenceToFirebase();
}

function unlinkDiscordAccount() {
    if (!confirm(t('unlinkConfirm'))) return;

    stopFriendsRealtimeSync();
    removeDiscordLinkData();
    localStorage.removeItem(getFriendsStoreStorageKey());
    localStorage.removeItem('azureFriendsStore');
    closeModal('modal-discord-auth');
    closeFriendProfile();
    renderFriendsPanel();
    showSection('friends');
    showToast(t('unlinkSuccess'));
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
    closeModal('modal-discord-auth');
    startFriendsRealtimeSync();
    renderFriendsPanel();
    showSection('friends');
    showToast(t('linkSuccess'));
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

// --- LÓGICA DE LA PANTALLA DE INICIO DE SESIÓN ---
function renderLoginAccounts() {
    const container = document.getElementById('offline-account-list') || document.getElementById('login-account-list');
    if (!container) return;

    const accounts = getStoredAccounts()
        .filter((acc) => acc.type !== 'premium')
        .sort((a, b) => Number(Boolean(b.isFavorite)) - Number(Boolean(a.isFavorite)) || a.name.localeCompare(b.name));

    container.innerHTML = '';

    if (accounts.length === 0) {
        container.innerHTML = `<p class="login-account-empty">${t('noOfflineAccounts')}</p>`;
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
    const versions = JSON.parse(localStorage.getItem('azureVersions') || '[]');
    const container = document.getElementById('versions-list');
    if (!container) return;

    if (versions.length === 0) {
        container.innerHTML = `<p class="empty-text">${t('versionsEmpty')}</p>`;
        return;
    }

    container.innerHTML = versions.map(ver => `<div class="version-item">${ver}</div>`).join('');
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
    const settingsPanel = document.getElementById('settings-panel');
    const ssGrid = document.getElementById('ss-grid');
    const serverList = document.getElementById('server-list');
    const friendsPanel = document.getElementById('friends-panel');
    const screenshotModal = document.getElementById('screenshot-modal');

    if (section !== 'servers') {
        stopServerRefresh();
    }

    if (playInfo) playInfo.classList.add('hidden');
    if (settingsPanel) settingsPanel.style.display = 'none';
    if (serverList) {
        serverList.style.display = 'none';
        if (section !== 'servers') serverList.innerHTML = '';
    }
    if (friendsPanel) friendsPanel.style.display = 'none';
    if (ssGrid) {
        ssGrid.style.display = 'none';
        if (section !== 'screenshots') ssGrid.innerHTML = '';
    }

    if (section === 'play') {
        if (screenshotModal) screenshotModal.classList.add('hidden');
        playInfo?.classList.remove('hidden');
    } else if (section === 'screenshots') {
        if (screenshotModal) screenshotModal.classList.remove('hidden');
        if (ssGrid) ssGrid.style.display = 'grid';
        loadScreenshots();
    } else if (section === 'servers') {
        if (screenshotModal) screenshotModal.classList.add('hidden');
        if (serverList) serverList.style.display = 'grid';
        openServers();
    } else if (section === 'friends') {
        if (screenshotModal) screenshotModal.classList.add('hidden');
        if (friendsPanel) friendsPanel.style.display = 'block';
        renderFriendsPanel();
    } else if (section === 'settings') {
        if (screenshotModal) screenshotModal.classList.add('hidden');
        settingsPanel.style.display = 'block';
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
        if (pendingDeleteIndex !== null) {
            deleteAccount(pendingDeleteIndex);
            pendingDeleteIndex = null;
        }
        closeConfirm();
    }, 350);
}

function showOfflineLogin() {
    showScreen('screen-offline-login');
    renderLoginAccounts();

    const input = document.getElementById('offline-name');
    setTimeout(() => input?.focus(), 150);
}

function loginOffline() {
    const input = document.getElementById('offline-name');
    const name = input?.value.trim() || '';

    if (name.length < 3) {
        showToast('Introduce un nombre válido');
        return;
    }

    const account = addAccountToStorage({
        username: name,
        type: 'offline',
        avatar: getCachedAvatar(name) || createOfflineAvatar(name)
    });

    if (input) input.value = '';
    selectAccount(account, { closeModal: false, updateList: true });
    showScreen('screen-dashboard');
}

function openMicrosoftLogin() {
    // Aquí se puede integrar el método real de login Microsoft + OAuth;
    // por ahora, la transición será la misma que la login offline sencilla.
    alert('Login Premium no implementado aún. Usa offline para pruebas.');
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
    const selectedVersion = document.getElementById('version-select')?.value || '1.20.4';

    ipc.send('update-rpc', {
        user: userName,
        version: selectedVersion,
        status
    });
}

// LANZAR JUEGO
function launch() {
    const user = document.getElementById('user-name') ? document.getElementById('user-name').innerText : 'JugadorAzure';
    const selectedVersion = document.getElementById('version-select')?.value || '1.20.4';

    updateDiscordStatus('Jugando');
    ipc.send('launch-game', { username: user, version: selectedVersion });
}

ipc.on('status', (e, msg) => {
    const launchStatus = document.getElementById('launch-status');
    if (launchStatus) {
        launchStatus.innerText = msg;
    }

    if (String(msg).includes('¡Juego Iniciado!')) {
        updateDiscordStatus('Jugando');
    }
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

const playButton = document.getElementById('btn-play-main');
if (playButton) {
    playButton.addEventListener('click', launch);
}

const versionSelect = document.getElementById('version-select');
if (versionSelect) {
    versionSelect.addEventListener('change', () => updateDiscordStatus('En el menú'));
}

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

loadStatusBar();

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
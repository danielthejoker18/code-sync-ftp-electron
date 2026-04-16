const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const Store = require('electron-store');
const ftp = require("basic-ftp");
const chokidar = require("chokidar");

const store = new Store();

let mainWindow;
let tray = null; // Variável da Bandeja
let watchers = [];
const client = new ftp.Client();

// Variáveis de Estado
let uploadQueue = [];
let isUploading = false;
let isSyncing = false; // Para controlar o texto do menu (Iniciar/Parar)
let isQuitting = false; // Para saber se é pra fechar mesmo ou só esconder

// --- EVENTO BEFORE-QUIT (Correção para CMD+Q e Dock Quit) ---
app.on('before-quit', () => {
    isQuitting = true;
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 750,
        autoHideMenuBar: true,
        icon: path.join(__dirname, 'icon.ico'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile('index.html');

    // --- LÓGICA DE FECHAR (X) ---
    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault(); // Cancela o fechamento
            mainWindow.hide();      // Esconde a janela
            // No macOS, não queremos sumir da Dock ao fechar a janela, pois é comportamento padrão manter o app rodando.
            if (process.platform !== 'darwin') {
                mainWindow.setSkipTaskbar(true); // <--- FORÇA SUMIR DA BARRA DE TAREFAS (Windows/Linux)
            }
            return false;
        }
    });

    // --- LÓGICA DE MINIMIZAR (_) ---
    mainWindow.on('minimize', (event) => {
        event.preventDefault();
        mainWindow.hide();
        if (process.platform !== 'darwin') {
            mainWindow.setSkipTaskbar(true);
        }
    });

    // --- QUANDO MOSTRAR DE NOVO ---
    mainWindow.on('show', () => {
        mainWindow.setSkipTaskbar(false); // Volta a aparecer na barra de tarefas
        if (process.platform === 'darwin') {
            app.dock.show();
        }
    });
}

// --- EVENTO ACTIVATE (Importante para macOS) ---
app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    } else {
        if (mainWindow) {
            mainWindow.show();
            if (process.platform === 'darwin') {
                app.dock.show();
            }
        }
    }
});

// --- CRIAÇÃO DA BANDEJA (TRAY) ---
function createTray() {
    const iconPath = path.join(__dirname, 'icon.ico');
    const trayIcon = nativeImage.createFromPath(iconPath);

    tray = new Tray(trayIcon);
    tray.setToolTip('CodeSyncFtp'); // Texto ao passar o mouse

    tray.on('double-click', () => {
        mainWindow.show();
    });

    updateTrayMenu(); // Cria o menu inicial
}

function updateTrayMenu() {
    if (!tray) return;

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Abrir CodeSyncFtp',
            click: () => mainWindow.show()
        },
        { type: 'separator' },
        {
            label: isSyncing ? 'Parar' : 'Iniciar',
            click: () => {
                // Ao clicar no Tray, avisamos o Front para clicar no botão virtualmente
                // Isso mantém a lógica centralizada
                if (mainWindow) {
                    mainWindow.webContents.send('toggle-sync-request');
                }
            }
        },
        { type: 'separator' },
        {
            label: 'Sair',
            click: () => {
                isQuitting = true; // Agora pode fechar
                app.quit();
            }
        }
    ]);

    tray.setContextMenu(contextMenu);
}

// TRAVA DE INSTÂNCIA ÚNICA
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit(); // Encerra se já houver outro rodando
} else {
    // Se for a instância principal, escuta tentativas de abertura
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.setSkipTaskbar(false);
            if (process.platform === 'darwin') {
                app.dock.show();
            }
            mainWindow.focus();
        }
    });

    // Inicia o App somente se tiver a trava
    app.whenReady().then(() => {
        createWindow();
        createTray();
    });
}

// --- COMUNICAÇÃO ---

ipcMain.on('save-settings', (event, data) => {
    store.set('config', data);
    console.log('Configurações salvas.');
});

// 2. Carregar configurações ao abrir
ipcMain.handle('get-settings', () => {
    return store.get('config', { projects: [] });
});

ipcMain.handle('test-ftp-credentials', async (event, config) => {
    const testClient = new ftp.Client();

    sendLog("Testando credenciais FTP...", "info");

    try {
        await testClient.access({
            host: config.host,
            user: config.user,
            password: config.password,
            port: parseInt(config.port) || 21,
            secure: false
        });

        sendLog("Credenciais FTP válidas.", "success");
        return { ok: true, message: "Conexão FTP estabelecida com sucesso!" };
    } catch (err) {
        sendLog(`Falha no teste FTP: ${err.message}`, "error");
        return { ok: false, message: `Falha ao conectar: ${err.message}` };
    } finally {
        testClient.close();
    }
});

ipcMain.handle('list-remote-directories', async (event, payload) => {
    const { config, path: requestedPath } = payload || {};
    const browserClient = new ftp.Client();

    try {
        await browserClient.access({
            host: config.host,
            user: config.user,
            password: config.password,
            port: parseInt(config.port) || 21,
            secure: false
        });

        let targetPath = (requestedPath || '/').trim();
        if (!targetPath.startsWith('/')) {
            targetPath = `/${targetPath}`;
        }

        try {
            await browserClient.cd(targetPath);
        } catch (_) {
            await browserClient.cd('/');
        }

        const currentPath = await browserClient.pwd();
        const entries = await browserClient.list();
        const directories = entries
            .filter(item => item.isDirectory)
            .map(item => item.name)
            .filter(name => name !== '.' && name !== '..')
            .sort((a, b) => a.localeCompare(b));

        return {
            ok: true,
            currentPath,
            directories
        };
    } catch (err) {
        return {
            ok: false,
            message: `Falha ao listar diretórios remotos: ${err.message}`
        };
    } finally {
        browserClient.close();
    }
});

// 3. Selecionar Pasta (Diálogo nativo do SO)
ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    return result.filePaths[0];
});

// 4. INICIAR O SYNC
ipcMain.on('start-sync', async (event, config) => {
    sendLog("Iniciando servico...", "info");
    await stopAllWatchers();

    uploadQueue = [];
    isUploading = false;

    if (!config.projects || config.projects.length === 0) {
        sendLog("Nenhuma pasta configurada!", "error");
        return;
    }

    try {
        await client.access({
            host: config.host,
            user: config.user,
            password: config.password,
            port: parseInt(config.port) || 21,
            secure: false
        });
        sendLog("Conexao FTP estabelecida!", "success");
    } catch (err) {
        sendLog(`Erro FTP: ${err.message}`, "error");
        // Avisa o front que falhou para destravar o botão
        event.reply('sync-error');
        return;
    }

    config.projects.forEach(proj => {
        createProjectWatcher(proj, config);
    });

    isSyncing = true;
    updateTrayMenu(); // Atualiza menu do Tray para "Parar"
    sendLog(`Monitorando ${config.projects.length} projetos...`, "info");
});

// --- STOP SYNC ---
ipcMain.on('stop-sync', async () => {
    await stopAllWatchers();
    client.close();
    uploadQueue = [];
    isUploading = false;

    isSyncing = false;
    updateTrayMenu(); // Atualiza menu do Tray para "Iniciar"

    sendLog("Servico parado.", "error");
});

// --- WATCHER ---

function createProjectWatcher(project, globalConfig) {
    const userIgnored = project.ignored
        ? project.ignored.split(',').map(item => item.trim().toLowerCase())
        : [];

    const systemIgnored = [/node_modules/, /\.git/, /\.vscode/, /desktop\.ini/];

    const w = chokidar.watch(project.local, {
        ignored: systemIgnored,
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
    });

    w.on('all', async (event, fullPath) => {
        if (event === 'addDir') return;

        const fileName = path.basename(fullPath).toLowerCase();
        const shouldIgnore = userIgnored.some(rule => {
            if (rule.startsWith('*')) return fileName.endsWith(rule.replace('*', ''));
            return fileName === rule;
        });

        if (shouldIgnore) {
            if (event !== 'unlink' && event !== 'unlinkDir') {
                sendLog(`Ignorado: ${path.basename(fullPath)}`, "info");
            }
            return;
        }

        let action = null;
        if (event === 'add' || event === 'change') action = 'upload';
        else if (event === 'unlink') action = 'delete_file';
        else if (event === 'unlinkDir') action = 'delete_dir';

        if (action) {
            addToQueue(action, fullPath, project, globalConfig);
        }
    });

    watchers.push(w);
}

async function stopAllWatchers() {
    for (const w of watchers) {
        await w.close();
    }
    watchers = [];
}

// --- QUEUE ---

function addToQueue(action, fullPath, projectConfig, globalConfig) {
    uploadQueue.push({ action, fullPath, projectConfig, globalConfig });
    processQueue();
}

async function processQueue() {
    if (isUploading || uploadQueue.length === 0) return;

    isUploading = true;
    const task = uploadQueue.shift();

    try {
        await handleSyncTask(task);
    } catch (err) {
        console.error("Erro na fila:", err);
    } finally {
        isUploading = false;
        if (uploadQueue.length > 0) {
            processQueue();
        } else {
            sendLog("Sincronismo em dia.", "info");
        }
    }
}

// --- EXECUTOR ---

async function handleSyncTask({ action, fullPath, projectConfig, globalConfig }) {
    const relativePath = path.relative(projectConfig.local, fullPath);
    const remotePath = (projectConfig.remote + "/" + relativePath)
        .split(path.sep).join(path.posix.sep)
        .replace('//', '/');

    try {
        if (client.closed) {
            await client.access({
                host: globalConfig.host,
                user: globalConfig.user,
                password: globalConfig.password,
                port: parseInt(globalConfig.port) || 21,
                secure: false
            });
        }

        if (action === 'upload') {
            sendLog(`[Upload] ${relativePath}`, "info");
            await client.ensureDir(path.dirname(remotePath));
            await client.uploadFrom(fullPath, remotePath);
            sendLog(`Sucesso: ${relativePath}`, "success");
        }
        else if (action === 'delete_file') {
            sendLog(`[Del File] ${relativePath}`, "error");
            try { await client.remove(remotePath); } catch (e) { if (!e.message.includes("550")) throw e; }
            sendLog(`Removido: ${relativePath}`, "success");
        }
        else if (action === 'delete_dir') {
            sendLog(`[Del Dir] ${relativePath}`, "error");
            try { await client.removeDir(remotePath); } catch (e) { if (!e.message.includes("550")) throw e; }
            sendLog(`Pasta removida: ${relativePath}`, "success");
        }

    } catch (err) {
        sendLog(`Erro (${action}): ${err.message}`, "error");
    }
}

function sendLog(msg, type) {
    if (mainWindow) {
        mainWindow.webContents.send('log-msg', { msg, type, time: new Date().toLocaleTimeString() });
    }
    console.log(`[${type}] ${msg}`);
}
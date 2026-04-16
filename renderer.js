const { ipcRenderer } = require('electron');

// Elementos DOM
const projectList = document.getElementById('projects-list');
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnTest = document.getElementById('btnTest');
const logsDiv = document.getElementById('logs');

// Carregar dados salvos ao abrir
window.onload = async () => {
    const config = await ipcRenderer.invoke('get-settings');
    
    if(config) {
        document.getElementById('host').value = config.host || '';
        document.getElementById('user').value = config.user || '';
        document.getElementById('password').value = config.password || '';
        document.getElementById('port').value = config.port || 21;
        
        // Recriar linhas dos projetos
        if(config.projects && config.projects.length > 0) {
            config.projects.forEach(p => addProjectRow(p.local, p.remote));
        } else {
            addProjectRow(); // Adiciona uma linha vazia padrão
        }
    } else {
        addProjectRow();
    }
};

// Função para adicionar linha de projeto na tela
function addProjectRow(localVal = '', remoteVal = '') {
    const div = document.createElement('div');
    div.className = 'project-row';
    div.innerHTML = `
        <div style="display:flex; gap:5px;">
            <input type="text" value="${localVal}" placeholder="Pasta Local (C:\\...)" class="input-local" readonly>
            <button class="btn-folder" onclick="selectFolder(this)">📂</button>
        </div>
        <input type="text" value="${remoteVal}" placeholder="Pasta Remota (/web/...)" class="input-remote">
        <button class="btn-remove" onclick="removeRow(this)">X</button>
    `;
    projectList.appendChild(div);
}

// Remover linha
function removeRow(btn) {
    btn.parentElement.remove();
}

// Abrir seletor de pasta nativo
async function selectFolder(btn) {
    const path = await ipcRenderer.invoke('select-folder');
    if (path) {
        // Acha o input ao lado do botão
        const inputLocal = btn.previousElementSibling;
        inputLocal.value = path;
    }
}

function collectConnectionConfig() {
    return {
        host: document.getElementById('host').value.trim(),
        user: document.getElementById('user').value.trim(),
        password: document.getElementById('password').value,
        port: document.getElementById('port').value
    };
}

function setSyncUiRunning(running) {
    btnStart.style.display = running ? 'none' : 'block';
    btnStop.style.display = running ? 'block' : 'none';
    disableInputs(running);
}

async function testCredentials() {
    const config = collectConnectionConfig();

    if (!config.host || !config.user) {
        alert("Preencha host e usuário para testar as credenciais.");
        return;
    }

    const originalText = btnTest.innerText;
    btnTest.disabled = true;
    btnTest.innerText = 'Testando...';

    try {
        const result = await ipcRenderer.invoke('test-ftp-credentials', config);
        alert(result.message);
    } catch (err) {
        alert(`Erro ao testar credenciais: ${err.message}`);
    } finally {
        btnTest.disabled = false;
        btnTest.innerText = originalText;
    }
}

// Salvar e Iniciar/Parar
function toggleSync(start) {
    if (start) {
        // 1. Coletar dados
        const config = {
            ...collectConnectionConfig(),
            projects: []
        };

        // 2. Coletar Projetos
        const rows = document.querySelectorAll('.project-row');
        rows.forEach(row => {
            const local = row.querySelector('.input-local').value;
            const remote = row.querySelector('.input-remote').value;
            if(local && remote) {
                config.projects.push({ local, remote });
            }
        });

        if (config.projects.length === 0) {
            alert("Adicione pelo menos um projeto válido!");
            return;
        }

        // 3. Salvar no disco e Enviar pro Main
        ipcRenderer.send('save-settings', config);
        ipcRenderer.send('start-sync', config);

        // UI Update
        setSyncUiRunning(true);

    } else {
        ipcRenderer.send('stop-sync');
        setSyncUiRunning(false);
    }
}

function disableInputs(disabled) {
    const inputs = document.querySelectorAll('input, .btn-remove, .btn-add, .btn-folder, .btn-test');
    inputs.forEach(el => el.disabled = disabled);
}

// Receber Logs do Backend
ipcRenderer.on('log-msg', (event, data) => {
    const p = document.createElement('div');
    p.className = `log-item ${data.type}`;
    p.innerText = `[${data.time}] ${data.msg}`;
    logsDiv.prepend(p);
});

// Se o usuário clicar em "Iniciar/Parar" lá no menu do Relógio
ipcRenderer.on('toggle-sync-request', () => {
    // Verifica se o botão START está visível
    if (btnStart.style.display !== 'none') {
        toggleSync(true); // Inicia
    } else {
        toggleSync(false); // Para
    }
});

// Se der erro de conexão no Main, destrava a tela
ipcRenderer.on('sync-error', () => {
    setSyncUiRunning(false);
    alert("Erro ao conectar no FTP. Verifique o log.");
});
let state = {
    repoLoaded: false,
    repoUrl: '',
    repoName: '',
    messages: [],
    processing: false,
    collectionName: '',
    allRepos: [],
    sessionId: null 
};

const BASE_URL = 'http://localhost:5000';


async function apiLoadRepo(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600000);
    try {
        const res = await fetch(`${BASE_URL}/load_repo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
            signal: controller.signal
        });
        clearTimeout(timeout);
        return res.json();
    } catch (err) {
        clearTimeout(timeout);
        throw err;
    }
}

async function apiAddRepo(url, collectionName, sessionId) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600000);
    try {
        const res = await fetch(`${BASE_URL}/add_repo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, collection_name: collectionName, session_id: sessionId }),
            signal: controller.signal
        });
        clearTimeout(timeout);
        return res.json();
    } catch (err) {
        clearTimeout(timeout);
        throw err;
    }
}

async function apiAskQuery(query) {
    const res = await fetch(`${BASE_URL}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            query,
            collection_name: state.collectionName,
            session_id: state.sessionId
        })
    });
    return res.json();
}

async function apiGetHistory() {
    const res = await fetch(`${BASE_URL}/history`);
    return res.json();
}

async function apiGetSessionMessages(sessionId) {
    const res = await fetch(`${BASE_URL}/history/${sessionId}`);
    return res.json();
}

async function apiDeleteSession(sessionId) {
    const res = await fetch(`${BASE_URL}/history/${sessionId}`, { method: 'DELETE' });
    return res.json();
}


function showToast(msg, type = '') {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.className = `toast ${type} show`;
    setTimeout(() => toast.classList.remove('show'), 3000);
}

function setProgress(pct, label) {
    document.getElementById('progressBar').style.width = pct + '%';
    document.getElementById('progressLabel').textContent = label;
}

function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
}

async function loadHistorySidebar() {
    const data = await apiGetHistory();
    if (data.error) { showToast('Failed to load history', 'error'); return; }

    const container = document.getElementById('sessionList');

    document.getElementById('sessionsDivider').classList.remove('hidden');
    document.getElementById('sessionLabel').classList.remove('hidden');

    if (!data.sessions || data.sessions.length === 0) {
        container.innerHTML = '<div style="font-size:11px;color:var(--text3);font-family:var(--mono);padding:8px 20px;">No past sessions yet.</div>';
        return;
    }

    container.innerHTML = data.sessions.map(s => `
        <div class="session-item ${state.sessionId === s.id ? 'active' : ''}"
             id="session-item-${s.id}"
             onclick="loadSessionFromHistory(${s.id})">
            <div class="session-item-icon">💬</div>
            <div class="session-item-info">
                <div class="session-item-title">${s.title || s.repos.join(', ')}</div>
                <div class="session-item-meta">${s.message_count} messages</div>
            </div>
            <button class="session-delete-btn"
                onclick="event.stopPropagation(); deleteSessionItem(${s.id}, this)"
                title="Delete">🗑</button>
        </div>
    `).join('');
}
async function loadSessionFromHistory(sessionId) {
    const data = await apiGetSessionMessages(sessionId);
    if (data.error) { showToast('Failed to load session', 'error'); return; }

    const session = data.session;

    state.sessionId      = session.id;
    state.collectionName = session.collection_name;
    state.allRepos       = session.repos;
    state.repoName       = session.repos[0];
    state.messages       = [];

    document.getElementById('repoName').textContent   = session.title || session.repos[0];
    document.getElementById('githubLink').href = session.repoUrl || "#";

    document.getElementById('messagesArea').innerHTML = '';
    data.messages.forEach(msg => addMessage(msg.role, msg.content));

    document.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
    const activeEl = document.getElementById(`session-item-${sessionId}`);
    if (activeEl) activeEl.classList.add('active');
    document.getElementById('landing').classList.add('hidden');
    document.getElementById('chatInterface').classList.remove('hidden');
    document.getElementById('statsRow').classList.remove('hidden');
    document.getElementById('resetBtn').classList.remove('hidden');
    renderSourcesList();

    showToast('Session restored!', 'success');
}
async function deleteSessionItem(sessionId, btnEl) {
    if (!confirm('Delete this session?')) return;
    const data = await apiDeleteSession(sessionId);
    if (data.success) {
        btnEl.closest('.session-item').remove();
        if (state.sessionId === sessionId) resetRepo();
        showToast('Session deleted', 'success');
    }
}
function renderSourcesList() {
    const list = document.getElementById('sourcesList');
    if (!state.allRepos || state.allRepos.length === 0) {
        list.innerHTML = '';
        return;
    }

    const reposOnly = [...new Set(state.allRepos.filter(r => {
        const parts = r.split('/');
        return parts.length === 2 && !r.includes('.');
    }))];

    const displayRepos = reposOnly.length > 0 ? reposOnly : [state.repoName];

    list.innerHTML = displayRepos.map((repo, index) => `
        <div class="repo-source-item ${index === 0 && displayRepos.length === 1 ? 'selected' : ''}">
            <span class="repo-source-icon">📁</span>
            <div class="repo-source-info">
                <span class="repo-source-number">${index + 1}.</span>
                <span class="repo-source-name" title="${repo}">${repo}</span>
            </div>
            <button class="repo-select-btn" onclick="selectRepo('${repo}', this)">
                Select
            </button>
        </div>
    `).join('');
}

function selectRepo(repoName, btnEl) {
    document.querySelectorAll('.repo-source-item').forEach(item => {
        item.classList.remove('selected');
    });
    btnEl.closest('.repo-source-item').classList.add('selected');
    document.getElementById('repoName').textContent = repoName;
    showToast(`Switched to ${repoName}`, 'success');
}



function addMessage(role, content) {
    state.messages.push({ role, content });
    const area = document.getElementById('messagesArea');
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    const avatarText = role === 'user' ? 'YOU' : '🤖';
    const formattedContent = role === 'ai' ? formatMarkdown(content) : escapeHtml(content);
    div.innerHTML = `
      <div class="msg-avatar">${avatarText}</div>
      <div class="msg-bubble">${formattedContent}</div>
    `;
    area.appendChild(div);
    area.scrollTop = area.scrollHeight;
}

function addThinkingIndicator() {
    const area = document.getElementById('messagesArea');
    const div = document.createElement('div');
    div.className = 'msg ai';
    div.id = 'thinkingMsg';
    div.innerHTML = `
      <div class="msg-avatar">🤖</div>
      <div class="msg-bubble">
        <div class="thinking"><span></span><span></span><span></span></div>
      </div>
    `;
    area.appendChild(div);
    area.scrollTop = area.scrollHeight;
}

function removeThinkingIndicator() {
    const el = document.getElementById('thinkingMsg');
    if (el) el.remove();
}

function formatMarkdown(text) {
    text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) =>
        `<pre><code>${escapeHtml(code.trim())}</code></pre>`
    );
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    text = text.replace(/^### (.+)$/gm, '<h4 style="color:var(--accent2);margin:10px 0 6px;font-size:13px;">$1</h4>');
    text = text.replace(/^## (.+)$/gm, '<h3 style="color:var(--accent2);margin:10px 0 6px;font-size:14px;">$1</h3>');
    text = text.replace(/^# (.+)$/gm, '<h2 style="color:var(--accent2);margin:10px 0 6px;font-size:15px;">$1</h2>');
    text = text.replace(/^- (.+)$/gm, '<li>$1</li>');
    text = text.replace(/(<li>.*<\/li>\n?)+/gs, '<ul>$&</ul>');
    text = text.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    text = text.split('\n\n').map(p => {
        if (p.startsWith('<')) return p;
        return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    }).join('');
    return text;
}

function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}



function addRepo() {
    const isFirst = state.allRepos.length === 0;
    document.getElementById('addRepoUrl').value = '';
    document.getElementById('addRepoStatus').textContent = '';
    document.getElementById('modalTitle').textContent = isFirst ? '📁 Load Repository' : '➕ Add Repository';
    document.getElementById('modalSubtitle').textContent = isFirst
        ? '// enter a github repository url'
        : '// add to current chat session';
    document.getElementById('confirmBtnText').textContent = isFirst ? 'Load Repository' : 'Add Repository';
    document.getElementById('addRepoModal').classList.remove('hidden');
    setTimeout(() => document.getElementById('addRepoUrl').focus(), 100);
}

function closeAddRepoModal() {
    document.getElementById('addRepoModal').classList.add('hidden');
}

async function confirmAddRepo() {
    const url = document.getElementById('addRepoUrl').value.trim();
    if (!url) return;

    const confirmBtn = document.getElementById('addRepoConfirmBtn');
    const status = document.getElementById('addRepoStatus');
    const isFirst = state.allRepos.length === 0;

    confirmBtn.disabled = true;
    confirmBtn.querySelector('.btn-text').style.display = 'none';
    confirmBtn.querySelector('.add-spinner').style.display = 'block';
    status.style.color = 'var(--accent2)';
    status.textContent = isFirst ? '📂 Loading repository...' : '📂 Adding repository...';

    if (isFirst) {
        document.getElementById('landing').classList.add('hidden');
        document.getElementById('progressWrap').classList.remove('hidden');
        let fakeProgress = 10;
        window._progressTimer = setInterval(() => {
            if (fakeProgress < 85) {
                fakeProgress += 2;
                if (fakeProgress < 30) setProgress(fakeProgress, '📂 Scanning repository...');
                else if (fakeProgress < 50) setProgress(fakeProgress, '⬇️ Fetching files...');
                else if (fakeProgress < 70) setProgress(fakeProgress, '🔪 Chunking files...');
                else setProgress(fakeProgress, '🔢 Embedding chunks...');
            }
        }, 3000);
    }

    try {
        let data;
        if (isFirst) {
            data = await apiLoadRepo(url);
        } else {
            data = await apiAddRepo(url, state.collectionName, state.sessionId);
        }

        if (window._progressTimer) {
            clearInterval(window._progressTimer);
            window._progressTimer = null;
        }

        if (data.error) {
            status.style.color = 'var(--red)';
            status.textContent = '❌ ' + data.error;
            if (isFirst) {
                document.getElementById('landing').classList.remove('hidden');
                document.getElementById('progressWrap').classList.add('hidden');
            }
            confirmBtn.disabled = false;
            confirmBtn.querySelector('.btn-text').style.display = 'block';
            confirmBtn.querySelector('.add-spinner').style.display = 'none';
            return;
        }

        if (isFirst) {
            setProgress(100, '✅ Repository loaded!');
            
            await new Promise(r => setTimeout(r, 500));
            document.getElementById('progressWrap').classList.add('hidden');

            state.repoLoaded = true;
            state.repoUrl = url;
            state.repoName = data.repo_name;
            state.collectionName = data.collection_name || '';
            state.allRepos = data.all_repos || [data.repo_name];
            state.sessionId = data.session_id || null; 

            document.getElementById('repoName').textContent = state.repoName;
            document.getElementById('githubLink').href = state.repoUrl;
            document.getElementById('statsRow').classList.remove('hidden');
            document.getElementById('resetBtn').classList.remove('hidden');
            document.getElementById('chatInterface').classList.remove('hidden');

        } else {
            state.allRepos = data.all_repos || state.allRepos;
            addMessage('ai', `✅ **Added \`${data.repo_name}\`** to this session.\n\nNow analyzing **${state.allRepos.length} repositories**. Ask anything about any of them!`);
        }
        renderSourcesList();
        closeAddRepoModal();
        showToast(`${data.repo_name} ${isFirst ? 'loaded' : 'added'}!`, 'success');
        loadHistorySidebar(); 
    } catch (err) {
        if (window._progressTimer) {
            clearInterval(window._progressTimer);
            window._progressTimer = null;
        }
        status.style.color = 'var(--red)';
        status.textContent = '❌ Failed. Please try again.';
        if (isFirst) {
            document.getElementById('landing').classList.remove('hidden');
            document.getElementById('progressWrap').classList.add('hidden');
        }
        console.error(err);
    }

    confirmBtn.disabled = false;
    confirmBtn.querySelector('.btn-text').style.display = 'block';
    confirmBtn.querySelector('.add-spinner').style.display = 'none';
}
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('addRepoModal').addEventListener('click', function(e) {
        if (e.target === this) closeAddRepoModal();
    });
    loadHistorySidebar();
});

async function sendMessage() {
    if (state.processing) return;
    const input = document.getElementById('chatInput');
    const query = input.value.trim();
    if (!query) return;
    input.value = '';
    input.style.height = 'auto';
    await processQuery(query);
}

async function sendSuggestion(btn) {
    if (state.processing) return;
    const query = btn.textContent;
    document.getElementById('suggestionsWrap').classList.add('hidden');
    await processQuery(query);
}

async function processQuery(query) {
    if (state.processing) return;
    state.processing = true;
    document.getElementById('sendBtn').disabled = true;

    addMessage('user', query);
    addThinkingIndicator();

    try {
        const data = await apiAskQuery(query);
        removeThinkingIndicator();
        if (data.error) {
            addMessage('ai', '⚠️ ' + data.error);
        } else {
            addMessage('ai', data.answer);
        }
    } catch (err) {
        removeThinkingIndicator();
        addMessage('ai', '⚠️ Rate limit hit. Please wait 30 seconds and try again.');
        console.error(err);
    }

    state.processing = false;
    document.getElementById('sendBtn').disabled = false;
    document.getElementById('chatInput').focus();
}

function clearChat() {
    if (state.messages.length === 0) { showToast('Chat is already empty', ''); return; }
    if (!confirm('Clear all chat messages?')) return;
    state.messages = [];
    document.getElementById('messagesArea').innerHTML = `
      <div id="suggestionsWrap">
        <div class="suggestion-label">Suggested Questions</div>
        <div class="suggestions-grid">
          <button class="suggestion-btn" onclick="sendSuggestion(this)">What is this repository about?</button>
          <button class="suggestion-btn" onclick="sendSuggestion(this)">What are the main files and their purpose?</button>
          <button class="suggestion-btn" onclick="sendSuggestion(this)">How do I set up and run this project?</button>
          <button class="suggestion-btn" onclick="sendSuggestion(this)">What dependencies does this project use?</button>
        </div>
      </div>
    `;
    showToast('Chat cleared!', 'success');
}



function resetRepo() {
    state = {
        repoLoaded: false, repoUrl: '', repoName: '',
        files: [], chunks: 0, messages: [],
        processing: false, collectionName: '',
        allRepos: [], sessionId: null
    };

    document.getElementById('sourcesList').innerHTML = '';
    document.getElementById('fileList').innerHTML = '';
    document.getElementById('statsRow').classList.add('hidden');
    document.getElementById('filesLabel').classList.add('hidden');
    document.getElementById('filesDivider').classList.add('hidden');
    document.getElementById('resetBtn').classList.add('hidden');
    document.getElementById('messagesArea').innerHTML = `
      <div id="suggestionsWrap">
        <div class="suggestion-label">Suggested Questions</div>
        <div class="suggestions-grid">
          <button class="suggestion-btn" onclick="sendSuggestion(this)">What is this repository about?</button>
          <button class="suggestion-btn" onclick="sendSuggestion(this)">What are the main files and their purpose?</button>
          <button class="suggestion-btn" onclick="sendSuggestion(this)">How do I set up and run this project?</button>
          <button class="suggestion-btn" onclick="sendSuggestion(this)">What dependencies does this project use?</button>
        </div>
      </div>
    `;
    document.getElementById('chatInterface').classList.add('hidden');
    document.getElementById('landing').classList.remove('hidden');
    addRepo();
}

async function showHistory() {
    const data = await apiGetHistory();
    if (data.error) { showToast('Failed to load history', 'error'); return; }

    const modal = document.getElementById('historyModal');
    const list = document.getElementById('historyList');

    if (data.sessions.length === 0) {
        list.innerHTML = '<p style="color:var(--text3);font-family:var(--mono);font-size:12px;padding:12px 0;">No chat history yet.</p>';
    } else {
        list.innerHTML = data.sessions.map(s => `
            <div class="history-item">
                <div class="history-info" onclick="loadHistorySession(${s.id})">
                    <div class="history-repos">${s.repos.join(', ')}</div>
                    <div class="history-meta">${s.message_count} messages</div>
                </div>
                <button class="history-delete-btn" onclick="deleteHistorySession(${s.id}, this)">🗑</button>
            </div>
        `).join('');
    }

    modal.classList.remove('hidden');
}
function closeHistoryModal() {
    document.getElementById('historyModal').classList.add('hidden');
}
async function loadHistorySession(sessionId) {
    const data = await apiGetSessionMessages(sessionId);
    if (data.error) { showToast('Failed to load session', 'error'); return; }

    closeHistoryModal();

    document.getElementById('messagesArea').innerHTML = '';
    document.getElementById('suggestionsWrap') && document.getElementById('suggestionsWrap').remove();

    data.messages.forEach(msg => {
        addMessage(msg.role, msg.content);
    });

    showToast('History loaded!', 'success');
}

async function deleteHistorySession(sessionId, btnEl) {
    if (!confirm('Delete this session?')) return;
    const data = await apiDeleteSession(sessionId);
    if (data.success) {
        btnEl.closest('.history-item').remove();
        showToast('Session deleted', 'success');
    }
}

/**
 * SkyCoup - Main Application
 * Handles all UI screens, game flow, and ties together game engine + network.
 */

// ─────────────────────────────────────────────────────────────
//  State
// ─────────────────────────────────────────────────────────────

let role = null;        // 'host' | 'client'
let myId = null;        // This player's ID
let myName = null;      // This player's name
let hostNet = null;     // HostNetwork instance
let clientNet = null;   // ClientNetwork instance
let game = null;        // CoupGame instance (host only)
let localState = null;  // Last received game state (for this player)
let numPlayers = 2;     // How many players total (host sets this)
let playerSlots = [];   // [{id, name, offerCode, connected}] - host tracking
let qrInstances = {};   // QR code canvas instances by key

// ─────────────────────────────────────────────────────────────
//  Utility
// ─────────────────────────────────────────────────────────────

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

function $(id) { return document.getElementById(id); }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = $(id);
  if (el) el.classList.add('active');
}

function showToast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('visible'), 10);
  setTimeout(() => { t.classList.remove('visible'); setTimeout(() => t.remove(), 400); }, 3000);
}

function copyToClipboard(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => showToast('Copied!', 'success'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast('Copied!', 'success');
  }
}

function renderQR(containerId, text) {
  const el = $(containerId);
  if (!el) return;
  el.innerHTML = '';
  if (typeof QRCode === 'undefined') {
    el.textContent = '(QR unavailable offline – use text code below)';
    return;
  }
  try {
    const qr = new QRCode(el, {
      text,
      width: 200,
      height: 200,
      colorDark: '#1a1a2e',
      colorLight: '#f0f0f0',
      correctLevel: QRCode.CorrectLevel.M,
    });
    qrInstances[containerId] = qr;
  } catch (e) {
    el.textContent = '(QR too large – use text code)';
  }
}

// ─────────────────────────────────────────────────────────────
//  Home Screen
// ─────────────────────────────────────────────────────────────

function initHome() {
  $('btn-create').onclick = () => showScreen('screen-create');
  $('btn-join').onclick = () => showScreen('screen-join');
}

// ─────────────────────────────────────────────────────────────
//  Create Game (Host Setup)
// ─────────────────────────────────────────────────────────────

async function startHosting() {
  const name = $('host-name').value.trim();
  if (!name) { showToast('Enter your name', 'error'); return; }
  numPlayers = parseInt($('num-players').value);

  myName = name;
  myId = generateId();
  role = 'host';

  hostNet = new HostNetwork({
    onPlayerJoined: onPeerJoined,
    onPlayerLeft: onPeerLeft,
    onMessage: onHostReceiveMessage,
    onError: (e) => showToast('Connection error: ' + e, 'error'),
  });

  // Host is player 0
  playerSlots = [{ id: myId, name: myName, connected: true, offerCode: null }];

  // Create peer slots for other players
  showScreen('screen-host-setup');
  $('host-setup-title').textContent = `Connecting Players (${numPlayers - 1} more needed)`;
  const container = $('peer-slots');
  container.innerHTML = '';

  const btn = $('btn-start-game');
  btn.disabled = true;
  btn.onclick = startGame;

  for (let i = 1; i < numPlayers; i++) {
    playerSlots.push({ id: null, name: null, connected: false, offerCode: null });
    const slot = document.createElement('div');
    slot.className = 'peer-slot';
    slot.id = `slot-${i}`;
    slot.innerHTML = `
      <div class="slot-header">
        <span class="slot-badge pending">Slot ${i}</span>
        <span class="slot-status" id="slot-status-${i}">Waiting for player…</span>
      </div>
      <div class="code-section" id="slot-offer-section-${i}">
        <p class="code-label">📱 Player ${i}: Scan this QR or copy code below</p>
        <div class="qr-placeholder" id="slot-qr-${i}"><div class="spinner"></div></div>
        <div class="code-box-row">
          <textarea class="code-box" id="slot-offer-${i}" readonly rows="3"></textarea>
          <button class="btn-icon" onclick="copyToClipboard($('slot-offer-${i}').value)" title="Copy">📋</button>
        </div>
      </div>
      <div class="answer-section" id="slot-answer-section-${i}" style="display:none">
        <p class="code-label">✏️ Paste Player ${i}'s answer code:</p>
        <div class="code-box-row">
          <textarea class="code-box" id="slot-answer-${i}" rows="3" placeholder="Paste answer code here…"></textarea>
          <button class="btn btn-sm" onclick="submitAnswer(${i})">Connect</button>
        </div>
      </div>
      <div class="connected-badge" id="slot-connected-${i}" style="display:none">
        ✅ <strong id="slot-player-name-${i}">Player ${i}</strong> connected!
      </div>
    `;
    container.appendChild(slot);

    // Generate the offer async
    (async (idx) => {
      try {
        const offerCode = await hostNet.createOffer(idx);
        playerSlots[idx].offerCode = offerCode;
        $(`slot-offer-${idx}`).value = offerCode;
        renderQR(`slot-qr-${idx}`, offerCode);
        $(`slot-answer-section-${idx}`).style.display = '';
      } catch (e) {
        console.error('Offer error', e);
        showToast('Error creating offer for slot ' + idx, 'error');
      }
    })(i);
  }
}

async function submitAnswer(slotIdx) {
  const answerCode = $(`slot-answer-${slotIdx}`).value.trim();
  if (!answerCode) { showToast('Paste the answer code first', 'error'); return; }
  try {
    await hostNet.acceptAnswer(slotIdx, answerCode);
    showToast('Connecting to Player ' + slotIdx + '…', 'info');
  } catch (e) {
    console.error('Answer error', e);
    showToast('Invalid answer code. Try again.', 'error');
  }
}

function onPeerJoined({ id, name }) {
  // Find an unconnected slot and assign
  const slotIdx = playerSlots.findIndex(s => !s.connected && s.id === null);
  if (slotIdx === -1) {
    console.warn('No open slot for', id, name);
    return;
  }
  playerSlots[slotIdx] = { id, name, connected: true };

  // Update UI
  const badge = $(`slot-${slotIdx}`)?.querySelector('.slot-badge');
  if (badge) { badge.className = 'slot-badge connected'; }
  const statusEl = $(`slot-status-${slotIdx}`);
  if (statusEl) statusEl.textContent = name + ' joined!';
  $(`slot-offer-section-${slotIdx}`).style.display = 'none';
  $(`slot-answer-section-${slotIdx}`).style.display = 'none';
  $(`slot-connected-${slotIdx}`).style.display = '';
  $(`slot-player-name-${slotIdx}`).textContent = name;

  showToast(`${name} connected!`, 'success');

  // Enable start button when all slots filled
  const allConnected = playerSlots.every(s => s.connected);
  if (allConnected) {
    $('btn-start-game').disabled = false;
  }
}

function onPeerLeft(peerId) {
  showToast('A player disconnected!', 'error');
}

function startGame() {
  const players = playerSlots.map(s => ({ id: s.id, name: s.name }));
  game = new CoupGame(players);

  // Send each client their initial state
  broadcastGameState();
  showGameScreen();
}

// ─────────────────────────────────────────────────────────────
//  Join Game (Client Setup)
// ─────────────────────────────────────────────────────────────

async function joinGame() {
  const name = $('client-name').value.trim();
  const offerCode = $('join-offer-code').value.trim();
  if (!name) { showToast('Enter your name', 'error'); return; }
  if (!offerCode) { showToast('Paste the host offer code', 'error'); return; }

  myName = name;
  myId = generateId();
  role = 'client';

  clientNet = new ClientNetwork({
    onConnected: onClientConnected,
    onDisconnected: () => showToast('Disconnected from host', 'error'),
    onMessage: onClientReceiveMessage,
    onError: (e) => showToast('Error: ' + e, 'error'),
  });

  showScreen('screen-join-answer');
  $('join-generating').style.display = '';
  $('join-answer-ready').style.display = 'none';

  try {
    const answerCode = await clientNet.acceptOffer(offerCode, myId, myName);
    $('join-generating').style.display = 'none';
    $('join-answer-ready').style.display = '';
    $('join-answer-code').value = answerCode;
    renderQR('join-answer-qr', answerCode);
    $('btn-copy-answer').onclick = () => copyToClipboard(answerCode);
  } catch (e) {
    console.error('Join error', e);
    showToast('Error: ' + e.message, 'error');
    showScreen('screen-join');
  }
}

function onClientConnected() {
  showToast('Connected to host!', 'success');
  showScreen('screen-waiting');
  $('waiting-message').textContent = 'Connected! Waiting for host to start the game…';
}

// ─────────────────────────────────────────────────────────────
//  Game Message Handling
// ─────────────────────────────────────────────────────────────

function onHostReceiveMessage(senderId, msg) {
  if (!game) return;

  const result = game.handleMessage(senderId, msg);
  if (result.error) {
    hostNet.send(senderId, { type: 'error', message: result.error });
    return;
  }
  broadcastGameState();
}

function onClientReceiveMessage(msg) {
  if (msg.type === 'game_state') {
    localState = msg.state;
    renderGameState(localState);
    if (localState.phase === 'game_over') showGameOver(localState.winner);
  } else if (msg.type === 'error') {
    showToast('Error: ' + msg.message, 'error');
  }
}

function broadcastGameState() {
  // Update host's own view
  localState = game.getStateFor(myId);
  renderGameState(localState);
  if (localState.phase === 'game_over') showGameOver(localState.winner);

  // Send each peer their personalized state
  for (const [peerId] of Object.entries(hostNet.peers)) {
    hostNet.send(peerId, {
      type: 'game_state',
      state: game.getStateFor(peerId),
    });
  }
}

function sendAction(msg) {
  if (role === 'host') {
    onHostReceiveMessage(myId, msg);
  } else {
    clientNet.send(msg);
  }
}

// ─────────────────────────────────────────────────────────────
//  Game Screen Rendering
// ─────────────────────────────────────────────────────────────

const CARD_ICONS = {
  Duke: '👑', Assassin: '🗡️', Captain: '⚓', Ambassador: '🤝', Contessa: '💎', '?': '🂠'
};

const CARD_COLORS = {
  Duke: '#8b5cf6', Assassin: '#ef4444', Captain: '#3b82f6',
  Ambassador: '#10b981', Contessa: '#f59e0b', '?': '#374151'
};

function showGameScreen() {
  showScreen('screen-game');
}

function renderGameState(state) {
  if (!state) return;
  showScreen('screen-game');

  renderPlayers(state);
  renderMyCards(state);
  renderActionArea(state);
  renderLog(state.log);
}

function renderPlayers(state) {
  const container = $('players-area');
  container.innerHTML = '';
  for (const p of state.players) {
    const isMe = p.id === myId;
    const isCurrent = p.id === state.currentPlayerId;
    const div = document.createElement('div');
    div.className = `player-chip ${p.eliminated ? 'eliminated' : ''} ${isCurrent ? 'current-turn' : ''} ${isMe ? 'is-me' : ''}`;

    const cardIcons = p.cards.map(c =>
      c.revealed
        ? `<span class="card-mini revealed" style="background:${CARD_COLORS[c.type]}">${CARD_ICONS[c.type]}</span>`
        : `<span class="card-mini hidden"></span>`
    ).join('');

    div.innerHTML = `
      <div class="player-name">${escHtml(p.name)}${isMe ? ' (you)' : ''}${isCurrent ? ' 🎯' : ''}</div>
      <div class="player-info">
        <span class="coins">💰 ${p.coins}</span>
        <span class="cards-row">${cardIcons}</span>
      </div>
    `;
    container.appendChild(div);
  }
}

function renderMyCards(state) {
  const me = state.players.find(p => p.id === myId);
  if (!me) return;
  const container = $('my-cards');
  container.innerHTML = '';

  for (let i = 0; i < me.cards.length; i++) {
    const c = me.cards[i];
    const div = document.createElement('div');
    div.className = `my-card ${c.revealed ? 'revealed' : ''}`;
    div.style.background = c.revealed ? '#374151' : CARD_COLORS[c.type];
    div.innerHTML = `
      <div class="card-icon">${CARD_ICONS[c.type]}</div>
      <div class="card-name">${c.revealed ? '☠️ ' : ''}${c.type === '?' ? '?' : c.type}</div>
      ${c.revealed ? '<div class="card-dead">LOST</div>' : ''}
    `;
    div.dataset.cardIndex = i;
    container.appendChild(div);
  }
}

function renderActionArea(state) {
  const area = $('action-area');
  area.innerHTML = '';

  const me = state.players.find(p => p.id === myId);
  if (!me || me.eliminated) {
    area.innerHTML = '<p class="spectating">You have been eliminated. Watching the game…</p>';
    return;
  }

  const isMyTurn = state.currentPlayerId === myId;
  const waitingForMe = state.waitingFor?.includes(myId);
  const phase = state.phase;

  if (phase === 'action' && isMyTurn) {
    renderActionButtons(state, me);
  } else if (phase === 'respond' && waitingForMe) {
    renderRespondButtons(state, me);
  } else if (phase === 'respond_block' && waitingForMe) {
    renderRespondBlockButtons(state);
  } else if (phase === 'lose_influence' && waitingForMe) {
    renderLoseInfluenceButtons(state, me);
  } else if (phase === 'exchange' && state.pendingAction?.actorId === myId) {
    renderExchangeButtons(state, me);
  } else {
    const currentPlayer = state.players.find(p => p.id === state.currentPlayerId);
    area.innerHTML = `<p class="waiting-msg">⏳ Waiting for ${escHtml(currentPlayer?.name || '...')}…</p>`;

    // Show what's happening
    if (state.pendingAction) {
      const act = state.pendingAction;
      const actor = state.players.find(p => p.id === act.actorId);
      const target = act.targetId ? state.players.find(p => p.id === act.targetId) : null;
      area.innerHTML += `<p class="pending-action">🎭 ${escHtml(actor?.name)} declares <strong>${act.type.replace('_', ' ')}</strong>${target ? ' on ' + escHtml(target.name) : ''}</p>`;
    }
    if (state.pendingBlock) {
      const b = state.pendingBlock;
      area.innerHTML += `<p class="pending-action">🛡️ ${escHtml(b.blockerName)} blocks with <strong>${b.claimedCard}</strong></p>`;
    }
  }
}

function renderActionButtons(state, me) {
  const area = $('action-area');
  const available = getAvailableActionsLocal(state, me);
  const alivePlayers = state.players.filter(p => !p.eliminated && p.id !== myId);

  area.innerHTML = '<p class="your-turn-msg">🎯 Your Turn! Choose an action:</p>';

  const grid = document.createElement('div');
  grid.className = 'action-grid';

  for (const actionType of available) {
    const def = ACTIONS[actionType];
    const btn = document.createElement('button');
    btn.className = 'btn-action';
    btn.dataset.action = actionType;

    btn.innerHTML = `
      <span class="action-name">${def.name}</span>
      ${def.cost > 0 ? `<span class="action-cost">💰${def.cost}</span>` : ''}
      ${def.claimedCard ? `<span class="action-card">${CARD_ICONS[def.claimedCard]} ${def.claimedCard}</span>` : ''}
    `;

    if (def.requiresTarget) {
      btn.onclick = () => showTargetPicker(actionType, alivePlayers);
    } else {
      btn.onclick = () => sendAction({ type: 'action', actionType });
    }
    grid.appendChild(btn);
  }
  area.appendChild(grid);
}

function showTargetPicker(actionType, targets) {
  const area = $('action-area');
  area.innerHTML = `<p class="your-turn-msg">Choose a target for ${ACTIONS[actionType].name}:</p>`;
  const grid = document.createElement('div');
  grid.className = 'target-grid';
  for (const p of targets) {
    const btn = document.createElement('button');
    btn.className = 'btn-target';
    btn.innerHTML = `${escHtml(p.name)}<br><small>💰${p.coins} 🂠${p.cardCount}</small>`;
    btn.onclick = () => sendAction({ type: 'action', actionType, targetId: p.id });
    grid.appendChild(btn);
  }
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => renderActionArea(localState);
  area.appendChild(grid);
  area.appendChild(cancelBtn);
}

function renderRespondButtons(state, me) {
  const area = $('action-area');
  const act = state.pendingAction;
  const actor = state.players.find(p => p.id === act.actorId);
  const target = act.targetId ? state.players.find(p => p.id === act.targetId) : null;

  area.innerHTML = `
    <p class="respond-header">
      <strong>${escHtml(actor?.name)}</strong> declares
      <strong>${act.type.replace('_', ' ')}</strong>${target ? ' on <strong>' + escHtml(target.name) + '</strong>' : ''}
    </p>
  `;

  const btns = document.createElement('div');
  btns.className = 'respond-btns';

  // Pass button always available
  const passBtn = document.createElement('button');
  passBtn.className = 'btn btn-pass';
  passBtn.textContent = '✅ Pass';
  passBtn.onclick = () => sendAction({ type: 'pass' });
  btns.appendChild(passBtn);

  // Challenge button (if action is challengeable)
  const actionDef = ACTIONS[act.type];
  if (actionDef?.challengeable) {
    const challBtn = document.createElement('button');
    challBtn.className = 'btn btn-challenge';
    challBtn.innerHTML = `❓ Challenge (claim ${act.claimedCard}?)`;
    challBtn.onclick = () => {
      if (confirm(`Challenge ${actor?.name}'s ${act.claimedCard} claim?`)) {
        sendAction({ type: 'challenge' });
      }
    };
    btns.appendChild(challBtn);
  }

  // Block button (if blockable, and player is eligible)
  if (actionDef?.blockable) {
    const isTarget = !act.targetId || act.targetId === myId;
    if (isTarget) {
      for (const blockCard of actionDef.blockedBy) {
        const blockBtn = document.createElement('button');
        blockBtn.className = 'btn btn-block';
        blockBtn.innerHTML = `🛡️ Block with ${blockCard} ${CARD_ICONS[blockCard]}`;
        blockBtn.onclick = () => {
          if (confirm(`Block ${act.type.replace('_', ' ')} with ${blockCard}?`)) {
            sendAction({ type: 'block', claimedCard: blockCard });
          }
        };
        btns.appendChild(blockBtn);
      }
    }
  }

  area.appendChild(btns);
}

function renderRespondBlockButtons(state) {
  const area = $('action-area');
  const block = state.pendingBlock;
  const blocker = state.players.find(p => p.id === block.blockerId);

  area.innerHTML = `<p class="respond-header"><strong>${escHtml(blocker?.name)}</strong> claims to block with <strong>${block.claimedCard}</strong>.</p>`;

  const btns = document.createElement('div');
  btns.className = 'respond-btns';

  const acceptBtn = document.createElement('button');
  acceptBtn.className = 'btn btn-pass';
  acceptBtn.textContent = '✅ Accept Block';
  acceptBtn.onclick = () => sendAction({ type: 'accept_block' });
  btns.appendChild(acceptBtn);

  const challBtn = document.createElement('button');
  challBtn.className = 'btn btn-challenge';
  challBtn.innerHTML = `❓ Challenge Block (do they have ${block.claimedCard}?)`;
  challBtn.onclick = () => {
    if (confirm(`Challenge ${blocker?.name}'s ${block.claimedCard} block claim?`)) {
      sendAction({ type: 'challenge_block' });
    }
  };
  btns.appendChild(challBtn);

  area.appendChild(btns);
}

function renderLoseInfluenceButtons(state, me) {
  const area = $('action-area');
  area.innerHTML = '<p class="lose-influence-msg">⚠️ Choose a card to lose (reveal):</p>';

  const grid = document.createElement('div');
  grid.className = 'influence-grid';

  for (let i = 0; i < me.cards.length; i++) {
    const c = me.cards[i];
    if (c.revealed) continue;
    const btn = document.createElement('button');
    btn.className = 'btn-influence-card';
    btn.style.background = CARD_COLORS[c.type];
    btn.innerHTML = `${CARD_ICONS[c.type]}<br>${c.type}`;
    btn.onclick = () => {
      if (confirm(`Reveal your ${c.type}?`)) {
        sendAction({ type: 'lose_influence', cardIndex: i });
      }
    };
    grid.appendChild(btn);
  }
  area.appendChild(grid);
}

function renderExchangeButtons(state, me) {
  const area = $('action-area');
  if (!state.exchangeDraw) return;

  const liveCards = me.cards.filter(c => !c.revealed);
  const allCards = [...liveCards, ...state.exchangeDraw];
  const keepCount = liveCards.length;

  area.innerHTML = `<p class="exchange-msg">🤝 Ambassador Exchange: Select ${keepCount} card(s) to keep.</p>`;

  const selected = new Set();
  const grid = document.createElement('div');
  grid.className = 'influence-grid';

  allCards.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.className = 'btn-influence-card';
    btn.style.background = CARD_COLORS[c.type];
    btn.dataset.idx = i;
    btn.innerHTML = `${CARD_ICONS[c.type]}<br>${c.type}${i >= liveCards.length ? '<br><small>(drawn)</small>' : ''}`;
    btn.onclick = () => {
      if (selected.has(i)) {
        selected.delete(i);
        btn.classList.remove('selected');
      } else if (selected.size < keepCount) {
        selected.add(i);
        btn.classList.add('selected');
      }
      confirmBtn.disabled = selected.size !== keepCount;
    };
    grid.appendChild(btn);
  });

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn btn-primary';
  confirmBtn.textContent = 'Confirm Exchange';
  confirmBtn.disabled = true;
  confirmBtn.onclick = () => {
    sendAction({ type: 'exchange', keepIndices: [...selected] });
  };

  area.appendChild(grid);
  area.appendChild(confirmBtn);
}

function renderLog(log) {
  const el = $('game-log');
  if (!el || !log) return;
  el.innerHTML = log.map(l => `<div class="log-entry">${escHtml(l)}</div>`).join('');
}

function getAvailableActionsLocal(state, me) {
  const alive = state.players.filter(p => !p.eliminated);
  const result = [];
  for (const [type, def] of Object.entries(ACTIONS)) {
    if (me.coins < def.cost) continue;
    if (me.coins >= 10 && type !== 'coup') continue;
    if (def.requiresTarget && alive.filter(p => p.id !== myId).length === 0) continue;
    result.push(type);
  }
  return result;
}

function showGameOver(winnerId) {
  const winner = localState?.players?.find(p => p.id === winnerId);
  $('winner-name').textContent = winner ? winner.name : 'Unknown';
  $('winner-is-you').style.display = winnerId === myId ? '' : 'none';
  showScreen('screen-game-over');
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────
//  Initialization
// ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initHome();

  $('btn-go-create').onclick = () => startHosting();
  $('btn-go-join').onclick = () => joinGame();
  $('btn-back-home-1').onclick = () => showScreen('screen-home');
  $('btn-back-home-2').onclick = () => showScreen('screen-home');
  $('btn-play-again').onclick = () => location.reload();

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW error', e));
  }

  showScreen('screen-home');
});

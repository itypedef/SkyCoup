/**
 * SkyCoup - Main Application
 */

// ─────────────────────────────────────────────────────────────
//  State
// ─────────────────────────────────────────────────────────────

let isHost = false;
let myId = null;
let myName = null;
let hostNet = null;
let clientNet = null;
let game = null;
let localState = null;

// ─────────────────────────────────────────────────────────────
//  Utilities
// ─────────────────────────────────────────────────────────────

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

function $(id) { return document.getElementById(id); }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

function showToast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('visible'));
  setTimeout(() => { t.classList.remove('visible'); setTimeout(() => t.remove(), 400); }, 3000);
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────
//  Create Game (Host)
// ─────────────────────────────────────────────────────────────

async function startHosting() {
  const name = $('host-name').value.trim();
  if (!name) { showToast('Enter your name', 'error'); return; }

  myName = name;
  myId = generateId();
  isHost = true;

  hostNet = new HostNetwork({
    onPlayerJoined: onPeerJoined,
    onPlayerLeft: id => showToast('A player disconnected!', 'error'),
    onMessage: onHostReceiveMessage,
  });

  showScreen('screen-host-setup');
  $('host-setup-pin').textContent = '…';
  $('btn-start-game').disabled = true;

  try {
    const pin = await hostNet.start();
    $('host-setup-pin').textContent = pin;
  } catch (e) {
    showToast('Could not create game: ' + e.message, 'error');
    showScreen('screen-create');
  }
}

function onPeerJoined({ id, name }) {
  showToast(`${name} joined!`, 'success');
  updatePlayerList();
  const numPlayers = parseInt($('num-players').value);
  if (hostNet.connectedIds().length >= numPlayers - 1) {
    $('btn-start-game').disabled = false;
  }
}

function updatePlayerList() {
  const list = $('connected-players');
  list.innerHTML = [
    `<li>👑 ${escHtml(myName)} (you – host)</li>`,
    ...hostNet.connectedIds().map(id => `<li>✅ ${escHtml(hostNet.peers[id].playerName)}</li>`),
  ].join('');
}

function startGame() {
  const players = [
    { id: myId, name: myName },
    ...hostNet.connectedIds().map(id => ({ id, name: hostNet.peers[id].playerName })),
  ];
  game = new CoupGame(players);
  broadcastGameState();
  showScreen('screen-game');
}

// ─────────────────────────────────────────────────────────────
//  Join Game (Client)
// ─────────────────────────────────────────────────────────────

async function joinGame() {
  const name = $('client-name').value.trim();
  const pin = $('join-pin').value.trim();
  if (!name) { showToast('Enter your name', 'error'); return; }
  if (!/^\d{4}$/.test(pin)) { showToast('Enter a 4-digit PIN', 'error'); return; }

  myName = name;
  myId = generateId();
  isHost = false;

  clientNet = new ClientNetwork({
    onConnected: () => {
      showToast('Connected!', 'success');
      showScreen('screen-waiting');
    },
    onDisconnected: () => showToast('Disconnected from host', 'error'),
    onMessage: onClientReceiveMessage,
  });

  try {
    await clientNet.connect(pin, myId, myName);
  } catch (e) {
    showToast('Could not connect. Check PIN and WiFi.', 'error');
  }
}

// ─────────────────────────────────────────────────────────────
//  Game Message Handling
// ─────────────────────────────────────────────────────────────

function onHostReceiveMessage(senderId, msg) {
  const result = game.handleMessage(senderId, msg);
  if (result?.error) {
    hostNet.send(senderId, { type: 'error', message: result.error });
    return;
  }
  broadcastGameState();
}

function onClientReceiveMessage(msg) {
  if (msg.type === 'game_state') {
    localState = msg.state;
    renderGameState(localState);
    if (localState.phase === PHASE.GAME_OVER) showGameOver(localState.winner);
  } else if (msg.type === 'error') {
    showToast(msg.message, 'error');
  }
}

function broadcastGameState() {
  localState = game.getStateFor(myId);
  renderGameState(localState);
  if (localState.phase === PHASE.GAME_OVER) showGameOver(localState.winner);

  for (const peerId of hostNet.connectedIds()) {
    hostNet.send(peerId, { type: 'game_state', state: game.getStateFor(peerId) });
  }
}

function sendAction(msg) {
  if (isHost) onHostReceiveMessage(myId, msg);
  else clientNet.send(msg);
}

// ─────────────────────────────────────────────────────────────
//  Card display constants
// ─────────────────────────────────────────────────────────────

const CARD_ICONS = {
  Duke: '👑', Assassin: '🗡️', Captain: '⚓', Ambassador: '🤝', Contessa: '💎', '?': '🂠'
};

const CARD_COLORS = {
  Duke: '#8b5cf6', Assassin: '#ef4444', Captain: '#3b82f6',
  Ambassador: '#10b981', Contessa: '#f59e0b', '?': '#374151',
};

// ─────────────────────────────────────────────────────────────
//  Game Rendering
// ─────────────────────────────────────────────────────────────

function renderGameState(state) {
  showScreen('screen-game');
  renderPlayers(state);
  renderMyCards(state);
  renderActionArea(state);
  renderLog(state.log);
}

function renderPlayers(state) {
  $('players-area').innerHTML = state.players.map(p => {
    const isCurrent = p.id === state.currentPlayerId;
    const isMe = p.id === myId;
    const cardDots = p.cards.map(c =>
      c.revealed
        ? `<span class="card-mini revealed" style="background:${CARD_COLORS[c.type]}">${CARD_ICONS[c.type]}</span>`
        : `<span class="card-mini hidden"></span>`
    ).join('');
    return `
      <div class="player-chip ${p.eliminated ? 'eliminated' : ''} ${isCurrent ? 'current-turn' : ''} ${isMe ? 'is-me' : ''}">
        <div class="player-name">${escHtml(p.name)}${isMe ? ' (you)' : ''}${isCurrent ? ' 🎯' : ''}</div>
        <div class="player-info"><span class="coins">💰 ${p.coins}</span><span class="cards-row">${cardDots}</span></div>
      </div>`;
  }).join('');
}

function renderMyCards(state) {
  const me = state.players.find(p => p.id === myId);
  if (!me) return;
  $('my-cards').innerHTML = me.cards.map((c, i) => `
    <div class="my-card ${c.revealed ? 'revealed' : ''}" style="background:${c.revealed ? '#374151' : CARD_COLORS[c.type]}" data-idx="${i}">
      <div class="card-icon">${CARD_ICONS[c.type]}</div>
      <div class="card-name">${c.revealed ? '☠️ ' : ''}${c.type === '?' ? '?' : c.type}</div>
      ${c.revealed ? '<div class="card-dead">LOST</div>' : ''}
    </div>`).join('');
}

function renderLog(log) {
  $('game-log').innerHTML = log.map(l => `<div class="log-entry">${escHtml(l)}</div>`).join('');
}

function renderActionArea(state) {
  const area = $('action-area');
  const me = state.players.find(p => p.id === myId);

  if (!me || me.eliminated) {
    area.innerHTML = '<p class="spectating">You have been eliminated. Watching…</p>';
    return;
  }

  const isMyTurn = state.currentPlayerId === myId;
  const waitingForMe = state.waitingFor?.includes(myId);

  if (state.phase === PHASE.ACTION && isMyTurn) {
    renderActionButtons(state, me);
  } else if (state.phase === PHASE.RESPOND && waitingForMe) {
    renderRespondButtons(state);
  } else if (state.phase === PHASE.RESPOND_BLOCK && waitingForMe) {
    renderRespondBlockButtons(state);
  } else if (state.phase === PHASE.LOSE_INFLUENCE && waitingForMe) {
    renderLoseInfluenceButtons(me);
  } else if (state.phase === PHASE.EXCHANGE && state.pendingAction?.actorId === myId) {
    renderExchangeButtons(state, me);
  } else {
    const current = state.players.find(p => p.id === state.currentPlayerId);
    let html = `<p class="waiting-msg">⏳ Waiting for ${escHtml(current?.name ?? '…')}…</p>`;
    if (state.pendingAction) {
      const { type, actorId, targetId } = state.pendingAction;
      const actor = state.players.find(p => p.id === actorId);
      const target = state.players.find(p => p.id === targetId);
      html += `<p class="pending-action">🎭 ${escHtml(actor?.name)} declares <strong>${type.replace('_', ' ')}</strong>${target ? ' on ' + escHtml(target.name) : ''}</p>`;
    }
    if (state.pendingBlock) {
      const blocker = state.players.find(p => p.id === state.pendingBlock.blockerId);
      html += `<p class="pending-action">🛡️ ${escHtml(blocker?.name)} blocks with <strong>${state.pendingBlock.claimedCard}</strong></p>`;
    }
    area.innerHTML = html;
  }
}

function makeBtn(className, html, onclick) {
  const btn = document.createElement('button');
  btn.className = className;
  btn.innerHTML = html;
  btn.onclick = onclick;
  return btn;
}

function renderActionButtons(state, me) {
  const area = $('action-area');
  const alivePlayers = state.players.filter(p => !p.eliminated && p.id !== myId);
  const available = game
    ? game.getAvailableActions(myId)
    : Object.keys(ACTIONS).filter(t => {
        const d = ACTIONS[t];
        return me.coins >= d.cost && (me.coins < 10 || t === 'coup') &&
               (!d.requiresTarget || alivePlayers.length > 0);
      });

  area.innerHTML = '<p class="your-turn-msg">🎯 Your Turn!</p>';
  const grid = document.createElement('div');
  grid.className = 'action-grid';

  for (const type of available) {
    const def = ACTIONS[type];
    const btn = makeBtn('btn-action', `
      <span class="action-name">${def.name}</span>
      ${def.cost > 0 ? `<span class="action-cost">💰${def.cost}</span>` : ''}
      ${def.claimedCard ? `<span class="action-card">${CARD_ICONS[def.claimedCard]} ${def.claimedCard}</span>` : ''}
    `, def.requiresTarget ? () => showTargetPicker(type, alivePlayers) : () => sendAction({ type: 'action', actionType: type }));
    grid.appendChild(btn);
  }
  area.appendChild(grid);
}

function showTargetPicker(actionType, targets) {
  const area = $('action-area');
  area.innerHTML = `<p class="your-turn-msg">Choose target for ${ACTIONS[actionType].name}:</p>`;
  const grid = document.createElement('div');
  grid.className = 'target-grid';
  for (const p of targets) {
    grid.appendChild(makeBtn('btn-target',
      `${escHtml(p.name)}<br><small>💰${p.coins} 🂠${p.cardCount}</small>`,
      () => sendAction({ type: 'action', actionType, targetId: p.id })
    ));
  }
  area.appendChild(grid);
  area.appendChild(makeBtn('btn btn-secondary', 'Cancel', () => renderActionArea(localState)));
}

function renderRespondButtons(state) {
  const area = $('action-area');
  const { type, actorId, targetId, claimedCard } = state.pendingAction;
  const actor = state.players.find(p => p.id === actorId);
  const target = state.players.find(p => p.id === targetId);
  const def = ACTIONS[type];

  area.innerHTML = `<p class="respond-header"><strong>${escHtml(actor?.name)}</strong> declares <strong>${type.replace('_', ' ')}</strong>${target ? ' on <strong>' + escHtml(target.name) + '</strong>' : ''}</p>`;

  const btns = document.createElement('div');
  btns.className = 'respond-btns';
  btns.appendChild(makeBtn('btn btn-pass', '✅ Pass', () => sendAction({ type: 'pass' })));

  if (def?.challengeable) {
    btns.appendChild(makeBtn('btn btn-challenge', `❓ Challenge (${claimedCard}?)`,
      () => confirm(`Challenge ${actor?.name}'s ${claimedCard} claim?`) && sendAction({ type: 'challenge' })
    ));
  }

  if (def?.blockable) {
    const isTarget = !targetId || targetId === myId;
    if (isTarget) {
      for (const card of def.blockedBy) {
        btns.appendChild(makeBtn('btn btn-block', `🛡️ Block with ${card} ${CARD_ICONS[card]}`,
          () => confirm(`Block with ${card}?`) && sendAction({ type: 'block', claimedCard: card })
        ));
      }
    }
  }

  area.appendChild(btns);
}

function renderRespondBlockButtons(state) {
  const area = $('action-area');
  const { blockerId, claimedCard } = state.pendingBlock;
  const blocker = state.players.find(p => p.id === blockerId);

  area.innerHTML = `<p class="respond-header"><strong>${escHtml(blocker?.name)}</strong> blocks with <strong>${claimedCard}</strong>.</p>`;

  const btns = document.createElement('div');
  btns.className = 'respond-btns';
  btns.appendChild(makeBtn('btn btn-pass', '✅ Accept Block', () => sendAction({ type: 'accept_block' })));
  btns.appendChild(makeBtn('btn btn-challenge', `❓ Challenge (${claimedCard}?)`,
    () => confirm(`Challenge ${blocker?.name}'s ${claimedCard} block?`) && sendAction({ type: 'challenge_block' })
  ));
  area.appendChild(btns);
}

function renderLoseInfluenceButtons(me) {
  const area = $('action-area');
  area.innerHTML = '<p class="lose-influence-msg">⚠️ Choose a card to lose:</p>';
  const grid = document.createElement('div');
  grid.className = 'influence-grid';
  me.cards.forEach((c, i) => {
    if (c.revealed) return;
    grid.appendChild(makeBtn('btn-influence-card',
      `${CARD_ICONS[c.type]}<br>${c.type}`,
      () => confirm(`Reveal your ${c.type}?`) && sendAction({ type: 'lose_influence', cardIndex: i })
    ));
    grid.lastElementChild.style.background = CARD_COLORS[c.type];
  });
  area.appendChild(grid);
}

function renderExchangeButtons(state, me) {
  const area = $('action-area');
  if (!state.exchangeDraw) return;

  const liveCards = me.cards.filter(c => !c.revealed);
  const allCards = [...liveCards, ...state.exchangeDraw];
  const keepCount = liveCards.length;
  const selected = new Set();

  area.innerHTML = `<p class="exchange-msg">🤝 Keep ${keepCount} card(s):</p>`;
  const grid = document.createElement('div');
  grid.className = 'influence-grid';

  const confirmBtn = makeBtn('btn btn-primary', 'Confirm', () =>
    sendAction({ type: 'exchange', keepIndices: [...selected] })
  );
  confirmBtn.disabled = true;

  allCards.forEach((c, i) => {
    const btn = makeBtn('btn-influence-card',
      `${CARD_ICONS[c.type]}<br>${c.type}${i >= liveCards.length ? '<br><small>(drawn)</small>' : ''}`,
      () => {
        selected.has(i) ? selected.delete(i) : selected.size < keepCount && selected.add(i);
        btn.classList.toggle('selected', selected.has(i));
        confirmBtn.disabled = selected.size !== keepCount;
      }
    );
    btn.style.background = CARD_COLORS[c.type];
    grid.appendChild(btn);
  });

  area.appendChild(grid);
  area.appendChild(confirmBtn);
}

function showGameOver(winnerId) {
  const winner = localState?.players?.find(p => p.id === winnerId);
  $('winner-name').textContent = winner?.name ?? '?';
  $('winner-is-you').style.display = winnerId === myId ? '' : 'none';
  showScreen('screen-game-over');
}

// ─────────────────────────────────────────────────────────────
//  Bootstrap
// ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  $('btn-create').onclick = () => showScreen('screen-create');
  $('btn-join').onclick = () => showScreen('screen-join');
  $('btn-back-home-1').onclick = () => showScreen('screen-home');
  $('btn-back-home-2').onclick = () => showScreen('screen-home');
  $('btn-go-create').onclick = startHosting;
  $('btn-go-join').onclick = joinGame;
  $('btn-start-game').onclick = startGame;
  $('btn-play-again').onclick = () => location.reload();

  // PIN input: digits only, max 4
  $('join-pin').addEventListener('input', e => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  showScreen('screen-home');
});

/**
 * SkyCoup - Coup Game Engine
 * Manages all game rules, state, and logic for the Coup card game.
 */

const CARD_TYPES = ['Duke', 'Assassin', 'Captain', 'Ambassador', 'Contessa'];

const ACTIONS = {
  income:       { name: 'Income',       cost: 0, claimedCard: null,        requiresTarget: false, challengeable: false, blockable: false,  blockedBy: [] },
  foreign_aid:  { name: 'Foreign Aid',  cost: 0, claimedCard: null,        requiresTarget: false, challengeable: false, blockable: true,   blockedBy: ['Duke'] },
  coup:         { name: 'Coup',         cost: 7, claimedCard: null,        requiresTarget: true,  challengeable: false, blockable: false,  blockedBy: [] },
  tax:          { name: 'Tax',          cost: 0, claimedCard: 'Duke',      requiresTarget: false, challengeable: true,  blockable: false,  blockedBy: [] },
  assassinate:  { name: 'Assassinate',  cost: 3, claimedCard: 'Assassin',  requiresTarget: true,  challengeable: true,  blockable: true,   blockedBy: ['Contessa'] },
  steal:        { name: 'Steal',        cost: 0, claimedCard: 'Captain',   requiresTarget: true,  challengeable: true,  blockable: true,   blockedBy: ['Captain', 'Ambassador'] },
  exchange:     { name: 'Exchange',     cost: 0, claimedCard: 'Ambassador',requiresTarget: false, challengeable: true,  blockable: false,  blockedBy: [] },
};

const PHASE = {
  WAITING:        'waiting',        // Before game starts
  ACTION:         'action',         // Current player must choose action
  RESPOND:        'respond',        // Others can block/challenge the action
  RESPOND_BLOCK:  'respond_block',  // Active player can challenge the block
  LOSE_INFLUENCE: 'lose_influence', // A player must reveal/discard a card
  EXCHANGE:       'exchange',       // Ambassador exchanging cards
  GAME_OVER:      'game_over',      // Game ended
};

function createDeck() {
  const deck = [];
  for (const type of CARD_TYPES) {
    for (let i = 0; i < 3; i++) deck.push({ type, revealed: false });
  }
  return shuffle(deck);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class CoupGame {
  constructor(players) {
    // players: [{id, name}]
    this.state = this._initState(players);
  }

  _initState(players) {
    const deck = createDeck();
    const gamePlayers = players.map(p => ({
      id: p.id,
      name: p.name,
      coins: 2,
      cards: [deck.pop(), deck.pop()],
      eliminated: false,
    }));

    return {
      phase: PHASE.ACTION,
      players: gamePlayers,
      deck,
      currentPlayerIndex: 0,
      pendingAction: null,   // { type, actorId, targetId, claimedCard }
      pendingBlock: null,    // { blockerId, blockerName, claimedCard }
      pendingLoseInfluence: null, // { playerId, reason, afterResolve }
      exchangeDraw: null,    // cards drawn for exchange
      responses: {},         // { playerId: 'pass'|'block'|'challenge' }
      waitingFor: [],        // player IDs we need responses from
      log: ['Game started!'],
      winner: null,
    };
  }

  // Returns sanitized state for a specific player (hides others' face-down cards)
  getStateFor(playerId) {
    const s = this.state;
    return {
      phase: s.phase,
      currentPlayerId: s.players[s.currentPlayerIndex]?.id,
      players: s.players.map(p => ({
        id: p.id,
        name: p.name,
        coins: p.coins,
        eliminated: p.eliminated,
        cardCount: p.cards.filter(c => !c.revealed).length,
        cards: p.id === playerId
          ? p.cards  // show own cards (face-up and face-down)
          : p.cards.map(c => c.revealed ? c : { type: '?', revealed: false }), // hide others'
      })),
      pendingAction: s.pendingAction,
      pendingBlock: s.pendingBlock,
      pendingLoseInfluence: s.pendingLoseInfluence ? { playerId: s.pendingLoseInfluence.playerId } : null,
      exchangeDraw: playerId === s.pendingAction?.actorId ? s.exchangeDraw : null,
      waitingFor: s.waitingFor,
      responses: s.responses,
      log: s.log,
      winner: s.winner,
    };
  }

  // Process a player action/response
  handleMessage(senderId, msg) {
    const s = this.state;
    const sender = s.players.find(p => p.id === senderId);
    if (!sender || sender.eliminated) return { error: 'Invalid sender' };

    try {
      switch (msg.type) {
        case 'action':        return this._handleAction(senderId, msg);
        case 'pass':          return this._handlePass(senderId);
        case 'block':         return this._handleBlock(senderId, msg);
        case 'challenge':     return this._handleChallenge(senderId);
        case 'challenge_block': return this._handleChallengeBlock(senderId);
        case 'accept_block':  return this._handleAcceptBlock(senderId);
        case 'lose_influence': return this._handleLoseInfluence(senderId, msg);
        case 'exchange':      return this._handleExchange(senderId, msg);
        default:              return { error: 'Unknown message type' };
      }
    } catch (e) {
      console.error('Game error:', e);
      return { error: e.message };
    }
  }

  _currentPlayer() {
    return this.state.players[this.state.currentPlayerIndex];
  }

  _alivePlayers() {
    return this.state.players.filter(p => !p.eliminated);
  }

  _player(id) {
    return this.state.players.find(p => p.id === id);
  }

  _log(msg) {
    this.state.log.unshift(msg);
    if (this.state.log.length > 50) this.state.log.pop();
  }

  _handleAction(senderId, msg) {
    const s = this.state;
    if (s.phase !== PHASE.ACTION) return { error: 'Not in action phase' };
    if (this._currentPlayer().id !== senderId) return { error: 'Not your turn' };

    const actionDef = ACTIONS[msg.actionType];
    if (!actionDef) return { error: 'Unknown action' };

    const actor = this._player(senderId);
    const target = msg.targetId ? this._player(msg.targetId) : null;

    // Validate
    if (actor.coins >= 10 && msg.actionType !== 'coup') return { error: 'Must coup with 10+ coins' };
    if (actor.coins < actionDef.cost) return { error: 'Not enough coins' };
    if (actionDef.requiresTarget && (!target || target.eliminated)) return { error: 'Invalid target' };

    // Deduct cost
    actor.coins -= actionDef.cost;

    s.pendingAction = {
      type: msg.actionType,
      actorId: senderId,
      targetId: msg.targetId || null,
      claimedCard: actionDef.claimedCard,
    };

    this._log(`${actor.name} declares ${actionDef.name}${target ? ' on ' + target.name : ''}.`);

    // Income and Coup resolve immediately
    if (msg.actionType === 'income') {
      actor.coins += 1;
      this._log(`${actor.name} takes 1 coin. (${actor.coins} total)`);
      s.pendingAction = null;
      return this._nextTurn();
    }

    if (msg.actionType === 'coup') {
      this._log(`${actor.name} launches a Coup on ${target.name}!`);
      return this._startLoseInfluence(target.id, 'coup', () => this._nextTurn());
    }

    // All others need response phase
    return this._startResponsePhase();
  }

  _startResponsePhase() {
    const s = this.state;
    const action = ACTIONS[s.pendingAction.type];
    const alive = this._alivePlayers();

    // Who can respond?
    // For blockable actions: anyone (for foreign aid) or target (for steal/assassinate)
    // For challengeable: anyone
    let responders = alive.filter(p => p.id !== s.pendingAction.actorId);

    if (!action.challengeable && !action.blockable) {
      // Shouldn't happen (income/coup handled above)
      return this._resolveAction();
    }

    s.phase = PHASE.RESPOND;
    s.responses = {};
    s.waitingFor = responders.map(p => p.id);
    return { ok: true };
  }

  _handlePass(senderId) {
    const s = this.state;
    if (s.phase !== PHASE.RESPOND && s.phase !== PHASE.RESPOND_BLOCK) return { error: 'Cannot pass now' };
    if (!s.waitingFor.includes(senderId)) return { error: 'Not waiting for you' };

    s.responses[senderId] = 'pass';
    s.waitingFor = s.waitingFor.filter(id => id !== senderId);

    if (s.waitingFor.length === 0) {
      if (s.phase === PHASE.RESPOND) return this._resolveAction();
      if (s.phase === PHASE.RESPOND_BLOCK) return this._resolveBlock();
    }
    return { ok: true };
  }

  _handleBlock(senderId, msg) {
    const s = this.state;
    if (s.phase !== PHASE.RESPOND) return { error: 'Cannot block now' };
    if (!s.waitingFor.includes(senderId)) return { error: 'Not waiting for you' };

    const action = ACTIONS[s.pendingAction.type];
    if (!action.blockable) return { error: 'Action not blockable' };

    const blocker = this._player(senderId);
    // For targeted blockable actions (steal, assassinate), only target can block
    if (s.pendingAction.targetId && s.pendingAction.targetId !== senderId) {
      return { error: 'Only the target can block this action' };
    }
    if (!action.blockedBy.includes(msg.claimedCard)) return { error: 'Invalid block card' };

    s.pendingBlock = {
      blockerId: senderId,
      blockerName: blocker.name,
      claimedCard: msg.claimedCard,
    };

    this._log(`${blocker.name} blocks with ${msg.claimedCard}!`);

    // Active player can now challenge or accept the block
    const actor = this._player(s.pendingAction.actorId);
    s.phase = PHASE.RESPOND_BLOCK;
    s.responses = {};
    s.waitingFor = [actor.id];
    return { ok: true };
  }

  _handleChallenge(senderId) {
    const s = this.state;
    if (s.phase !== PHASE.RESPOND) return { error: 'Cannot challenge now' };
    if (!s.waitingFor.includes(senderId)) return { error: 'Not waiting for you' };

    const action = ACTIONS[s.pendingAction.type];
    if (!action.challengeable) return { error: 'Action not challengeable' };

    const challenger = this._player(senderId);
    const actor = this._player(s.pendingAction.actorId);
    this._log(`${challenger.name} challenges ${actor.name}'s ${s.pendingAction.claimedCard} claim!`);

    return this._resolveChallenge(
      actor.id,
      challenger.id,
      s.pendingAction.claimedCard,
      // If challenge fails (actor has card): resolve action
      () => this._resolveAction(),
      // If challenge succeeds (actor doesn't have card): action fails, actor loses influence
      () => this._startLoseInfluence(actor.id, 'challenge_failed', () => {
        s.pendingAction = null;
        return this._nextTurn();
      })
    );
  }

  _handleChallengeBlock(senderId) {
    const s = this.state;
    if (s.phase !== PHASE.RESPOND_BLOCK) return { error: 'Cannot challenge block now' };
    if (!s.waitingFor.includes(senderId)) return { error: 'Not waiting for you' };

    const blocker = this._player(s.pendingBlock.blockerId);
    const challenger = this._player(senderId);
    this._log(`${challenger.name} challenges ${blocker.name}'s ${s.pendingBlock.claimedCard} block!`);

    return this._resolveChallenge(
      blocker.id,
      challenger.id,
      s.pendingBlock.claimedCard,
      // If challenge fails (blocker has card): block succeeds
      () => {
        this._log(`Block is confirmed. Action blocked.`);
        s.pendingAction = null;
        s.pendingBlock = null;
        return this._nextTurn();
      },
      // If challenge succeeds (blocker doesn't have card): action resolves
      () => this._startLoseInfluence(blocker.id, 'challenge_failed', () => {
        this._log(`Block failed. Action resolves!`);
        s.pendingBlock = null;
        return this._resolveAction();
      })
    );
  }

  _handleAcceptBlock(senderId) {
    const s = this.state;
    if (s.phase !== PHASE.RESPOND_BLOCK) return { error: 'Cannot accept block now' };
    if (!s.waitingFor.includes(senderId)) return { error: 'Not waiting for you' };

    const actor = this._player(s.pendingAction.actorId);
    // Refund cost for assassinate (coins already deducted)
    if (s.pendingAction.type === 'assassinate') {
      actor.coins += 3;
    }

    this._log(`${actor.name} accepts the block. Action cancelled.`);
    s.pendingAction = null;
    s.pendingBlock = null;
    return this._nextTurn();
  }

  // Resolve a challenge: challenged player must show claimedCard or lose influence
  _resolveChallenge(challengedId, challengerId, claimedCard, onChallengeFailCB, onChallengeSucceedCB) {
    const challenged = this._player(challengedId);
    const challenger = this._player(challengerId);

    const cardIndex = challenged.cards.findIndex(c => !c.revealed && c.type === claimedCard);
    if (cardIndex !== -1) {
      // Challenged player HAS the card - challenge fails
      this._log(`${challenged.name} reveals ${claimedCard}. Challenge fails! ${challenger.name} loses influence.`);
      // Shuffle card back, draw new one
      const card = challenged.cards[cardIndex];
      this.state.deck.push(card);
      this.state.deck = shuffle(this.state.deck);
      challenged.cards[cardIndex] = this.state.deck.pop();
      this._log(`${challenged.name} draws a new card.`);
      // Challenger loses influence
      return this._startLoseInfluence(challengerId, 'challenge_failed', onChallengeFailCB);
    } else {
      // Challenged player does NOT have the card - challenge succeeds
      this._log(`${challenged.name} cannot show ${claimedCard}. Challenge succeeds!`);
      return onChallengeSucceedCB();
    }
  }

  _startLoseInfluence(playerId, reason, afterResolveCB) {
    const s = this.state;
    const player = this._player(playerId);
    const liveCards = player.cards.filter(c => !c.revealed);

    s.pendingLoseInfluence = { playerId, reason, afterResolveCB };

    if (liveCards.length === 1) {
      // Auto-reveal if only one card left
      const idx = player.cards.findIndex(c => !c.revealed);
      return this._handleLoseInfluence(playerId, { cardIndex: idx });
    }

    s.phase = PHASE.LOSE_INFLUENCE;
    s.waitingFor = [playerId];
    return { ok: true };
  }

  _handleLoseInfluence(senderId, msg) {
    const s = this.state;
    if (s.phase !== PHASE.LOSE_INFLUENCE && !s.pendingLoseInfluence) return { error: 'Not in lose influence phase' };
    if (!s.pendingLoseInfluence || s.pendingLoseInfluence.playerId !== senderId) return { error: 'Not your turn to lose influence' };

    const player = this._player(senderId);
    const card = player.cards[msg.cardIndex];
    if (!card || card.revealed) return { error: 'Invalid card index' };

    card.revealed = true;
    this._log(`${player.name} loses influence: ${card.type} is revealed!`);

    // Check if player is eliminated
    const liveCards = player.cards.filter(c => !c.revealed);
    if (liveCards.length === 0) {
      player.eliminated = true;
      this._log(`${player.name} is eliminated!`);
    }

    const afterCB = s.pendingLoseInfluence.afterResolveCB;
    s.pendingLoseInfluence = null;

    // Check win condition
    const alive = this._alivePlayers();
    if (alive.length === 1) {
      s.winner = alive[0].id;
      s.phase = PHASE.GAME_OVER;
      this._log(`${alive[0].name} wins the game!`);
      return { ok: true };
    }

    return afterCB ? afterCB() : { ok: true };
  }

  _resolveAction() {
    const s = this.state;
    const action = s.pendingAction;
    const actor = this._player(action.actorId);
    const target = action.targetId ? this._player(action.targetId) : null;

    switch (action.type) {
      case 'foreign_aid':
        actor.coins += 2;
        this._log(`${actor.name} takes Foreign Aid. (+2 coins, now ${actor.coins})`);
        s.pendingAction = null;
        return this._nextTurn();

      case 'tax':
        actor.coins += 3;
        this._log(`${actor.name} takes Tax. (+3 coins, now ${actor.coins})`);
        s.pendingAction = null;
        return this._nextTurn();

      case 'assassinate':
        this._log(`${actor.name} assassinates ${target.name}!`);
        s.pendingAction = null;
        return this._startLoseInfluence(target.id, 'assassinate', () => this._nextTurn());

      case 'steal': {
        const stolen = Math.min(2, target.coins);
        target.coins -= stolen;
        actor.coins += stolen;
        this._log(`${actor.name} steals ${stolen} coin(s) from ${target.name}.`);
        s.pendingAction = null;
        return this._nextTurn();
      }

      case 'exchange':
        // Draw 2 cards for ambassador exchange
        s.exchangeDraw = [s.deck.pop(), s.deck.pop()];
        this._log(`${actor.name} draws 2 cards to exchange.`);
        s.phase = PHASE.EXCHANGE;
        s.waitingFor = [actor.id];
        s.pendingAction = { ...s.pendingAction }; // keep action info
        return { ok: true };

      default:
        s.pendingAction = null;
        return this._nextTurn();
    }
  }

  _handleExchange(senderId, msg) {
    const s = this.state;
    if (s.phase !== PHASE.EXCHANGE) return { error: 'Not in exchange phase' };
    if (s.pendingAction?.actorId !== senderId) return { error: 'Not your exchange' };

    const actor = this._player(senderId);
    const liveCards = actor.cards.filter(c => !c.revealed);
    const allCards = [...liveCards, ...s.exchangeDraw];

    // keepIndices: indices into allCards array (must keep exactly liveCards.length cards)
    const keepCount = liveCards.length;
    const { keepIndices } = msg;
    if (!keepIndices || keepIndices.length !== keepCount) return { error: 'Invalid keep selection' };

    const keptCards = keepIndices.map(i => allCards[i]);
    const returnedCards = allCards.filter((_, i) => !keepIndices.includes(i));

    // Update actor's live card slots
    let liveIdx = 0;
    for (let i = 0; i < actor.cards.length; i++) {
      if (!actor.cards[i].revealed) {
        actor.cards[i] = keptCards[liveIdx++];
      }
    }

    // Return unused cards to deck
    for (const card of returnedCards) {
      s.deck.push(card);
    }
    s.deck = shuffle(s.deck);
    s.exchangeDraw = null;

    this._log(`${actor.name} completes Exchange.`);
    s.pendingAction = null;
    return this._nextTurn();
  }

  _resolveBlock() {
    // All passed on the block - block succeeds
    const s = this.state;
    const actor = this._player(s.pendingAction.actorId);
    // Refund assassinate cost
    if (s.pendingAction.type === 'assassinate') {
      actor.coins += 3;
    }
    this._log(`Block stands. Action cancelled.`);
    s.pendingAction = null;
    s.pendingBlock = null;
    return this._nextTurn();
  }

  _nextTurn() {
    const s = this.state;
    s.phase = PHASE.ACTION;
    s.responses = {};
    s.waitingFor = [];
    s.pendingBlock = null;

    const alive = this._alivePlayers();

    // Advance to next alive player
    do {
      s.currentPlayerIndex = (s.currentPlayerIndex + 1) % s.players.length;
    } while (s.players[s.currentPlayerIndex].eliminated);

    this._log(`--- ${this._currentPlayer().name}'s turn ---`);
    return { ok: true };
  }

  // Check if an action is available to a player
  getAvailableActions(playerId) {
    const s = this.state;
    if (s.phase !== PHASE.ACTION) return [];
    if (this._currentPlayer().id !== playerId) return [];

    const player = this._player(playerId);
    const alive = this._alivePlayers();
    const result = [];

    for (const [type, def] of Object.entries(ACTIONS)) {
      if (player.coins < def.cost) continue;
      if (player.coins >= 10 && type !== 'coup') continue;
      if (def.requiresTarget && alive.filter(p => p.id !== playerId).length === 0) continue;
      result.push(type);
    }
    return result;
  }
}

// Export
if (typeof module !== 'undefined') module.exports = { CoupGame, ACTIONS, PHASE, CARD_TYPES };

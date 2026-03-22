/**
 * SkyCoup - PeerJS Networking
 *
 * Host creates a peer with ID "skycoup-XXXX" (4-digit PIN).
 * Clients connect to that ID using the PIN. PeerJS handles all signaling.
 *
 * Requires internet/WiFi for initial PeerJS signaling (~1s), then runs P2P.
 */

const PEER_ID_PREFIX = 'skycoup-';

function makePeerId(pin) {
  return PEER_ID_PREFIX + pin;
}

function generatePin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// ─────────────────────────────────────────────────────────────
//  Host
// ─────────────────────────────────────────────────────────────

class HostNetwork {
  constructor({ onPlayerJoined, onPlayerLeft, onMessage }) {
    this.onPlayerJoined = onPlayerJoined;
    this.onPlayerLeft = onPlayerLeft;
    this.onMessage = onMessage;
    this.peers = {};  // playerId -> DataConnection
    this.peer = null;
    this.pin = null;
  }

  /** Create a PeerJS peer and return the 4-digit PIN when ready. */
  start() {
    return new Promise((resolve, reject) => {
      this.pin = generatePin();
      this._open(resolve, reject);
    });
  }

  _open(resolve, reject, attempts = 0) {
    const peer = new Peer(makePeerId(this.pin));
    this.peer = peer;

    peer.on('open', () => resolve(this.pin));

    peer.on('connection', conn => this._setupConn(conn));

    peer.on('error', err => {
      if (err.type === 'unavailable-id' && attempts < 5) {
        peer.destroy();
        this.pin = generatePin();
        this._open(resolve, reject, attempts + 1);
      } else {
        reject(err);
      }
    });
  }

  _setupConn(conn) {
    conn.on('data', data => {
      if (data.type === 'hello') {
        conn.playerId = data.playerId;
        conn.playerName = data.name;
        this.peers[data.playerId] = conn;
        this.onPlayerJoined({ id: data.playerId, name: data.name });
        return;
      }
      if (conn.playerId) this.onMessage(conn.playerId, data);
    });

    conn.on('close', () => {
      if (conn.playerId) {
        delete this.peers[conn.playerId];
        this.onPlayerLeft(conn.playerId);
      }
    });
  }

  send(playerId, msg) {
    const conn = this.peers[playerId];
    if (conn?.open) conn.send(msg);
  }

  broadcast(msg) {
    for (const conn of Object.values(this.peers)) {
      if (conn.open) conn.send(msg);
    }
  }

  connectedIds() {
    return Object.keys(this.peers);
  }
}

// ─────────────────────────────────────────────────────────────
//  Client
// ─────────────────────────────────────────────────────────────

class ClientNetwork {
  constructor({ onConnected, onDisconnected, onMessage }) {
    this.onConnected = onConnected;
    this.onDisconnected = onDisconnected;
    this.onMessage = onMessage;
    this.conn = null;
    this.peer = null;
  }

  /** Connect to a host using their 4-digit PIN. */
  connect(pin, playerId, playerName) {
    return new Promise((resolve, reject) => {
      this.peer = new Peer();

      this.peer.on('open', () => {
        this.conn = this.peer.connect(makePeerId(pin), { reliable: true });

        this.conn.on('open', () => {
          this.conn.send({ type: 'hello', playerId, name: playerName });
          this.onConnected();
          resolve();
        });

        this.conn.on('data', data => this.onMessage(data));
        this.conn.on('close', () => this.onDisconnected());
        this.conn.on('error', reject);
      });

      this.peer.on('error', reject);
    });
  }

  send(msg) {
    if (this.conn?.open) this.conn.send(msg);
  }
}

if (typeof module !== 'undefined') module.exports = { HostNetwork, ClientNetwork };

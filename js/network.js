/**
 * SkyCoup - WebRTC Networking Layer
 *
 * Supports two roles:
 *   HOST   - Runs the game engine, connects to each peer
 *   CLIENT - Connects to the host
 *
 * Signaling is done manually via copy-paste / QR code exchange.
 * Works completely offline on local WiFi or mobile hotspot.
 */

const ICE_SERVERS = [
  // STUN helps with NAT traversal when on the same WiFi network
  // Falls back to link-local ICE candidates if STUN is unreachable
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const ICE_GATHER_TIMEOUT_MS = 5000;

/**
 * Compress a string for compact transfer (QR/clipboard).
 * Uses LZString if available, otherwise raw base64.
 */
function encode(str) {
  try {
    if (typeof LZString !== 'undefined') {
      return 'lz:' + LZString.compressToBase64(str);
    }
  } catch (_) {}
  return 'b64:' + btoa(unescape(encodeURIComponent(str)));
}

function decode(str) {
  if (str.startsWith('lz:')) return LZString.decompressFromBase64(str.slice(3));
  if (str.startsWith('b64:')) return decodeURIComponent(escape(atob(str.slice(4))));
  // Legacy fallback
  return LZString.decompressFromBase64(str);
}

/** Wait for ICE gathering to complete (or timeout) */
function waitForIce(pc) {
  return new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const timer = setTimeout(resolve, ICE_GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', function handler() {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', handler);
        resolve();
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────
//  Host Connection Manager
// ─────────────────────────────────────────────────────────────

class HostNetwork {
  constructor({ onPlayerJoined, onPlayerLeft, onMessage, onError }) {
    this.onPlayerJoined = onPlayerJoined;
    this.onPlayerLeft = onPlayerLeft;
    this.onMessage = onMessage;
    this.onError = onError;
    this.peers = {}; // peerId -> { pc, dc, name }
    this.pendingOffers = {}; // slotIndex -> { pc, offerCode }
  }

  /**
   * Create an offer for one peer slot. Returns encoded offer string.
   * slotIndex: unique slot identifier (0,1,2...)
   */
  async createOffer(slotIndex) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const dc = pc.createDataChannel('coup', { ordered: true });

    let peerId = null;

    dc.onopen = () => {
      console.log(`[Host] Peer ${slotIndex} channel open`);
    };

    dc.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'hello') {
          peerId = msg.playerId;
          this.peers[peerId] = { pc, dc, name: msg.name };
          this.onPlayerJoined({ id: peerId, name: msg.name });
          return;
        }
        if (peerId) this.onMessage(peerId, msg);
      } catch (err) {
        console.error('[Host] DC message error', err);
      }
    };

    dc.onclose = () => {
      if (peerId && this.peers[peerId]) {
        delete this.peers[peerId];
        this.onPlayerLeft(peerId);
      }
    };

    pc.onicecandidate = () => {}; // candidates collected in SDP

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIce(pc);

    const offerCode = encode(JSON.stringify({
      type: 'offer',
      sdp: pc.localDescription,
    }));

    this.pendingOffers[slotIndex] = { pc, dc };
    return offerCode;
  }

  /**
   * Accept an answer from a peer. Call after peer scans/pastes your offer
   * and sends back their answer code.
   */
  async acceptAnswer(slotIndex, answerCode) {
    const pending = this.pendingOffers[slotIndex];
    if (!pending) throw new Error('No pending offer for slot ' + slotIndex);

    const { pc } = pending;
    const data = JSON.parse(decode(answerCode));
    if (data.type !== 'answer') throw new Error('Expected answer, got: ' + data.type);

    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    delete this.pendingOffers[slotIndex];
  }

  /** Send a message to a specific peer */
  send(peerId, msg) {
    const peer = this.peers[peerId];
    if (peer && peer.dc.readyState === 'open') {
      peer.dc.send(JSON.stringify(msg));
    }
  }

  /** Broadcast a message to all connected peers */
  broadcast(msg) {
    const json = JSON.stringify(msg);
    for (const peer of Object.values(this.peers)) {
      if (peer.dc.readyState === 'open') peer.dc.send(json);
    }
  }

  /** Broadcast a message to all except one */
  broadcastExcept(excludeId, msg) {
    const json = JSON.stringify(msg);
    for (const [id, peer] of Object.entries(this.peers)) {
      if (id !== excludeId && peer.dc.readyState === 'open') peer.dc.send(json);
    }
  }

  isConnected(peerId) {
    return this.peers[peerId]?.dc?.readyState === 'open';
  }

  connectedCount() {
    return Object.values(this.peers).filter(p => p.dc.readyState === 'open').length;
  }
}

// ─────────────────────────────────────────────────────────────
//  Client Connection Manager
// ─────────────────────────────────────────────────────────────

class ClientNetwork {
  constructor({ onConnected, onDisconnected, onMessage, onError }) {
    this.onConnected = onConnected;
    this.onDisconnected = onDisconnected;
    this.onMessage = onMessage;
    this.onError = onError;
    this.pc = null;
    this.dc = null;
  }

  /**
   * Accept a host's offer and generate an answer code.
   * Returns the encoded answer string to share back with the host.
   */
  async acceptOffer(offerCode, playerId, playerName) {
    const data = JSON.parse(decode(offerCode));
    if (data.type !== 'offer') throw new Error('Expected offer, got: ' + data.type);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;

    pc.ondatachannel = (e) => {
      const dc = e.channel;
      this.dc = dc;

      dc.onopen = () => {
        // Introduce ourselves to the host
        dc.send(JSON.stringify({ type: 'hello', playerId, name: playerName }));
        this.onConnected();
      };

      dc.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          this.onMessage(msg);
        } catch (err) {
          console.error('[Client] DC message error', err);
        }
      };

      dc.onclose = () => {
        this.onDisconnected();
      };
    };

    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIce(pc);

    return encode(JSON.stringify({
      type: 'answer',
      sdp: pc.localDescription,
    }));
  }

  /** Send a message to the host */
  send(msg) {
    if (this.dc && this.dc.readyState === 'open') {
      this.dc.send(JSON.stringify(msg));
    }
  }

  isConnected() {
    return this.dc?.readyState === 'open';
  }

  disconnect() {
    this.dc?.close();
    this.pc?.close();
    this.dc = null;
    this.pc = null;
  }
}

// Export
if (typeof module !== 'undefined') module.exports = { HostNetwork, ClientNetwork, encode, decode };

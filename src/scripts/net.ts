// ============================================================================
//  MULTIPLAYER TRANSPORT — WebRTC P2P via PeerJS.
//
//  Architecture: HOST-OWNED WORLD, peer-to-peer edits.
//  - The free PeerJS cloud broker only performs the WebRTC handshake; all game
//    traffic then flows browser↔browser on a reliable ordered DataChannel. No
//    game server — the static Vercel deploy is unchanged.
//  - Worldgen is deterministic from params.seed, so the WORLD never crosses the
//    network: on connect the host sends { params, edits, timeOfDay } once and
//    the guest regenerates locally — byte-identical terrain. After that only
//    block edits (~20 B events) and ~20 Hz position updates flow.
//  - Conflict policy: last-write-wins per block (fine for 2 players).
//
//  MVP scope: exactly ONE guest. Extra connection attempts are refused (a
//  3+-player version wants a relay/room server — see PartyKit — not N×N P2P).
// ============================================================================
import type { Peer, DataConnection } from 'peerjs';
import { ChunkParams } from './chunkGen';
import { BLOCK_IDS } from './blockTypes';

// Bounds for validating NETWORK-SUPPLIED edits (a peer is untrusted input).
// Derived from the real id table so new blocks never need a manual bump here.
const MAX_BLOCK_ID = Math.max(...Object.values(BLOCK_IDS));
const MAX_WORLD_Y = 512;          // generous ceiling (world is 320 tall today)
const MAX_WORLD_XZ = 30_000_000;  // |x|,|z| sanity bound (MC-style world border)
const MAX_EDIT_KEYS = 500_000;    // init-snapshot edit cap (~tens of MB of JSON)
// dataStore key format: "<chunkX>-<chunkZ>,<blockX>-<blockY>-<blockZ>" — chunk
// coords may be negative, block coords never are.
const EDIT_KEY_RE = /^-?\d+--?\d+,\d+-\d+-\d+$/;
const validEditId = (id: unknown): id is number =>
  typeof id === 'number' && Number.isInteger(id) && id >= 0 && id <= MAX_BLOCK_ID;

// peerjs is LAZY-LOADED on first host()/join() — it's ~50 KB gz that most
// sessions never use, so it must not weigh down the boot bundle (vite splits
// the dynamic import into its own chunk).
let PeerCtor: typeof Peer | null = null;
async function loadPeer(): Promise<typeof Peer> {
  if (!PeerCtor) {
    const mod = await import('peerjs');
    PeerCtor = mod.Peer ?? (mod as unknown as { default: typeof Peer }).default;
  }
  return PeerCtor;
}

export type NetState = 'off' | 'starting' | 'hosting' | 'connecting' | 'connected' | 'error';
export type NetStatus = { state: NetState; code: string; detail: string };

type InitMsg = { t: 'init'; params: ChunkParams; edits: Record<string, number>; timeOfDay: number };
type EditMsg = { t: 'edit'; x: number; y: number; z: number; id: number };
type PosMsg = { t: 'pos'; p: [number, number, number]; yaw: number; pitch: number };
type TimeMsg = { t: 'time'; tod: number };
type NetMsg = InitMsg | EditMsg | PosMsg | TimeMsg;

// Room codes: 6 chars, no lookalikes (0/O, 1/I/L). The code IS the host's peer
// id (namespaced) — the broker does the rendezvous, no room registry needed.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const peerIdFor = (code: string) => `mcjs-world-${code}`;
function makeCode(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
  return s;
}

const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export class Net {
  status: NetStatus = { state: 'off', code: '', detail: '' };
  get connected() { return this.status.state === 'connected'; }
  isHost = false;

  // Wired by main.ts:
  onInit?: (msg: { params: ChunkParams; edits: Record<string, number>; timeOfDay: number }) => void;
  onEdit?: (x: number, y: number, z: number, id: number) => void;
  onPos?: (p: [number, number, number], yaw: number, pitch: number) => void;
  onTime?: (tod: number) => void;
  onPeerChange?: (connected: boolean) => void;   // remote avatar show/hide
  getInitPayload?: () => { params: ChunkParams; edits: Record<string, number>; timeOfDay: number };

  private peer: Peer | null = null;
  private conn: DataConnection | null = null;

  private setStatus(state: NetState, code = this.status.code, detail = '') {
    this.status = { state, code, detail };
  }

  // Bumped on every host()/join()/leave() so a stale async continuation (the
  // lazy peerjs load resolving after the user clicked away) aborts cleanly.
  private opSeq = 0;

  // ---- HOST: claim a room code on the broker, wait for the guest -----------
  // isRetry distinguishes the internal collision re-roll from a user click
  // (which always starts with a fresh retry budget).
  async host(isRetry = false) {
    if (this.peer) this.leave();
    if (!isRetry) this.hostRetries = 0;
    const seq = ++this.opSeq;
    this.isHost = true;
    const code = makeCode();
    this.setStatus('starting', code, 'contacting broker…');
    let P: typeof Peer;
    try { P = await loadPeer(); }
    catch { this.setStatus('error', code, 'failed to load the networking module'); return; }
    if (seq !== this.opSeq) return;   // user cancelled / restarted while loading
    const peer = new P(peerIdFor(code));
    this.peer = peer;
    peer.on('open', () => {
      if (this.peer !== peer) return;
      this.hostRetries = 0;   // code claimed — reset the collision-retry budget
      this.setStatus('hosting', code, 'waiting for a friend to join…');
    });
    peer.on('connection', (conn) => {
      if (this.conn) { conn.close(); return; }   // MVP: one guest — refuse extras
      this.wire(conn);
    });
    peer.on('error', (e) => this.fail(e));
    peer.on('disconnected', () => { if (this.peer === peer && !this.conn) peer.reconnect(); });   // broker blip pre-join
  }

  // ---- GUEST: rendezvous with the host's code -------------------------------
  async join(code: string) {
    if (this.peer) this.leave();
    const seq = ++this.opSeq;
    this.isHost = false;
    code = code.trim().toUpperCase();
    if (code.length < 4) { this.setStatus('error', code, 'enter the host\'s room code'); return; }
    this.setStatus('connecting', code, 'contacting broker…');
    let P: typeof Peer;
    try { P = await loadPeer(); }
    catch { this.setStatus('error', code, 'failed to load the networking module'); return; }
    if (seq !== this.opSeq) return;   // user cancelled / restarted while loading
    const peer = new P();   // broker-assigned id; only the HOST needs a known id
    this.peer = peer;
    peer.on('open', () => {
      if (this.peer !== peer) return;
      this.setStatus('connecting', code, 'connecting to host…');
      // reliable+ordered: edits MUST apply in order; position traffic is light
      // enough to share the channel at 2 players.
      this.wire(peer.connect(peerIdFor(code), { reliable: true }));
    });
    peer.on('error', (e) => this.fail(e));
  }

  private wire(conn: DataConnection) {
    this.conn = conn;
    conn.on('open', () => {
      if (this.conn !== conn) return;
      this.setStatus('connected', this.status.code, this.isHost ? 'friend connected!' : 'connected to host!');
      // Host pushes the world snapshot the moment the channel opens — the guest
      // regenerates from it (terrain is deterministic, so this tiny blob IS the world).
      if (this.isHost && this.getInitPayload) {
        const p = this.getInitPayload();
        this.sendMsg({ t: 'init', params: p.params, edits: p.edits, timeOfDay: p.timeOfDay });
      }
      this.onPeerChange?.(true);
    });
    conn.on('data', (raw) => this.handle(raw));
    const drop = (detail: string) => {
      if (this.conn !== conn) return;
      this.conn = null;
      this.onPeerChange?.(false);
      // The host keeps the room open for a re-join; the guest's session is over.
      if (this.isHost) this.setStatus('hosting', this.status.code, detail + ' — waiting for a re-join…');
      else this.setStatus('error', this.status.code, detail);
    };
    conn.on('close', () => drop('peer left'));
    conn.on('error', () => drop('connection lost'));
  }

  // Incoming messages come from the NETWORK — validate before touching game state.
  private handle(raw: unknown) {
    const m = raw as NetMsg;
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'init': {
        if (this.isHost) return;   // only the host issues world snapshots
        const t = m.params?.terrain;
        if (!t || !fin(t.scale) || !fin(t.magnitude) || !fin(t.offset) || !fin(t.waterOffset) || !fin(m.params.seed)) return;
        if (m.edits === null || typeof m.edits !== 'object' || Array.isArray(m.edits)) return;
        // SANITIZE the edits blob — it becomes dataStore.data verbatim, and
        // rebuildIndex/forEachEdit assume the exact key format (a comma-less key
        // would parse to NaN coords and corrupt chunk data). Size-capped so a
        // hostile/buggy host can't freeze the main thread; only keys matching
        // the format with in-range integer ids are copied (this also discards
        // junk like __proto__, which can never match the pattern).
        const keys = Object.keys(m.edits);
        if (keys.length > MAX_EDIT_KEYS) return;
        const edits: Record<string, number> = {};
        for (const k of keys) {
          const v = (m.edits as Record<string, unknown>)[k];
          if (EDIT_KEY_RE.test(k) && validEditId(v)) edits[k] = v;
        }
        this.onInit?.({ params: m.params, edits, timeOfDay: fin(m.timeOfDay) ? m.timeOfDay : 0.3 });
        break;
      }
      case 'edit':
        if (Number.isInteger(m.x) && Number.isInteger(m.y) && Number.isInteger(m.z)
          && Math.abs(m.x) <= MAX_WORLD_XZ && m.y >= 0 && m.y <= MAX_WORLD_Y && Math.abs(m.z) <= MAX_WORLD_XZ
          && validEditId(m.id)) {
          this.onEdit?.(m.x, m.y, m.z, m.id);
        }
        break;
      case 'pos':
        if (Array.isArray(m.p) && m.p.length === 3 && m.p.every(fin) && fin(m.yaw) && fin(m.pitch)) {
          this.onPos?.(m.p as [number, number, number], m.yaw, m.pitch);
        }
        break;
      case 'time':
        if (!this.isHost && fin(m.tod)) this.onTime?.(((m.tod % 1) + 1) % 1);   // host owns the clock
        break;
    }
  }

  private hostRetries = 0;

  private fail(e: Error & { type?: string }) {
    // 'unavailable-id': our random room code collided on the broker — re-roll.
    // Bounded (a 31^6 namespace can't genuinely collide 4× — persistent
    // rejection means a misbehaving broker, so stop instead of spinning).
    if (this.isHost && e.type === 'unavailable-id' && this.hostRetries++ < 3) { this.host(true); return; }
    const detail =
      e.type === 'peer-unavailable' ? 'no host found for that code' :
      e.type === 'network' ? 'cannot reach the signaling broker (offline?)' :
      (e.message || String(e));
    this.setStatus('error', this.status.code, detail);
    this.teardown();
  }

  private sendMsg(m: NetMsg) {
    if (this.conn?.open) this.conn.send(m);
  }

  sendEdit(x: number, y: number, z: number, id: number) { this.sendMsg({ t: 'edit', x, y, z, id }); }
  sendPos(p: { x: number; y: number; z: number }, yaw: number, pitch: number) {
    // Positions are EPHEMERAL — on a slow link, queueing them behind a backed-up
    // reliable channel only adds lag to every later message (including edits).
    // Drop the update instead; the next one is 50 ms away. Edits always send.
    // (dataChannel is a public typed property on peerjs 1.5's DataConnection.)
    const dc = this.conn?.dataChannel;
    if (dc && dc.bufferedAmount > 64 * 1024) return;
    this.sendMsg({ t: 'pos', p: [p.x, p.y, p.z], yaw, pitch });
  }
  sendTime(tod: number) { if (this.isHost) this.sendMsg({ t: 'time', tod }); }
  // Re-snapshot the world to the guest (host regenerate / load while connected).
  sendInit() {
    if (this.isHost && this.getInitPayload) {
      const p = this.getInitPayload();
      this.sendMsg({ t: 'init', params: p.params, edits: p.edits, timeOfDay: p.timeOfDay });
    }
  }

  private teardown() {
    this.conn = null;
    if (this.peer) { this.peer.destroy(); this.peer = null; }
  }

  leave() {
    this.opSeq++;   // abort any in-flight host()/join() continuation
    const wasConnected = !!this.conn;
    this.teardown();
    this.setStatus('off', '', '');
    this.isHost = false;
    if (wasConnected) this.onPeerChange?.(false);
  }
}

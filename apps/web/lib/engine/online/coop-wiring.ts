// Co-op wiring, dependency-inverted onto the shared GameRuntime: the remote-edit appliers, room-state
// sync, the hurt cue, the local pose/edit forwarders, the debug snapshot, the offline-admin grant, the
// admin/GameApi bridge bind, and the createCoop call itself (startCoop). createCoop is invoked only when
// a server URL is configured AND the player did not choose single-player, so the offline path never
// opens a socket. All bodies move verbatim from the engine closure.
import { Vec3 } from '../vec3';
import { t } from '../../i18n';
import { debug } from '../../log';
import { AIR, EYE_HEIGHT } from '../constants';
import { clearFeetAbove } from '../actors';
import { buildDebugSnapshot, type DebugSnapshot } from '../debug-snapshot';
import { debugReportRing, formatDebugReport } from '../debug-report';
import { createCoop, MAIN_WORLD, type CoopHud, type RoomState } from '../../coop';
import { offlineAdminFeed, offlineResetFeed } from '../offline/feed-events';
import type { EditCell, EditOp } from '../../protocol';
import type { GameRuntime } from '../runtime';

export function createCoopWiring(runtime: GameRuntime): void {
  const { state, brand } = runtime;
  const player = state.player;

  // If a synced edit lands on the local player (e.g. a structure built where they stand), lift them out.
  runtime.unstuckPlayer = function unstuckPlayer(): void {
    const fx = Math.floor(player.pos.x), fz = Math.floor(player.pos.z);
    const feet = Math.floor(player.pos.y - EYE_HEIGHT);
    if (!runtime.isSolid(fx, feet, fz) && !runtime.isSolid(fx, feet + 1, fz)) return;
    player.pos.y = clearFeetAbove({ feet, isSolid: (y) => runtime.isSolid(fx, y, fz) }) + EYE_HEIGHT;
    player.vel.set(0, 0, 0);
  };

  runtime.applyRemoteEdit = function applyRemoteEdit({ x, y, z, id, mine }: { x: number; y: number; z: number; id: number; mine: boolean }): void {
    if (!runtime.inBounds(x, y, z)) return;
    // When the server confirms OUR own dig broke a block, that is when we collect it (digs are
    // server-authoritative now, so we wait for the break instead of applying it optimistically).
    if (mine && id === AIR) {
      const removed = runtime.getVoxel(x, y, z);
      if (removed !== AIR) { player.bag += 1; runtime.inventory.bank(removed); runtime.updateHotbarCounts(); runtime.updateStats(); }
    }
    runtime.setVoxel(x, y, z, id);
    runtime.remeshRegion(x - 1, x + 1, z - 1, z + 1);
    runtime.unstuckPlayer();
    debug('coop', 'remote edit', { x, y, z, id, mine });
  };

  runtime.applyRemoteEditBatch = function applyRemoteEditBatch(edits: EditCell[]): void {
    if (edits.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const { x, y, z, id } of edits) {
      if (!runtime.inBounds(x, y, z)) continue;
      runtime.setVoxel(x, y, z, id);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (minX <= maxX) runtime.remeshRegion(minX - 1, maxX + 1, minZ - 1, maxZ + 1);
    runtime.unstuckPlayer();
    debug('coop', 'remote edit batch', { count: edits.length });
  };

  // Room-wide settings (admin-controlled, server-authoritative): peace calms the local creatures for
  // everyone, and blocked structures disable those entries in the build menu.
  runtime.applyRoomState = function applyRoomState({ peace, blockedStructures: blocked, pvp: pvpOn, chatEnabled: chatOn, approvalRequired: approval }: RoomState): void {
    state.peaceful = peace;
    state.pvp = pvpOn;
    state.chatEnabled = chatOn;
    state.approvalRequired = approval;
    runtime.blockedStructures.clear();
    for (const kind of blocked) runtime.blockedStructures.add(kind);
    runtime.syncBuildMenu();
    debug('engine', 'room state applied', { peace, blocked: blocked.length, pvp: pvpOn, chat: chatOn, approval });
  };

  // Offline there is no server room: admin toggles mutate the local state directly and refresh the HUD
  // (online always routes through coop instead, so the two paths never mix).
  runtime.currentRoom = (): RoomState => ({ peace: state.peaceful, blockedStructures: [...runtime.blockedStructures], pvp: state.pvp, chatEnabled: state.chatEnabled, suspended: false, approvalRequired: state.approvalRequired, playtimeLimitMin: 0, playtimeWindowH: 0, onlineAllowed: true, offlineAllowed: true });

  runtime.applyLocalRoom = function applyLocalRoom(next: RoomState): void {
    runtime.applyRoomState(next);
    runtime.bridge?.hud.onRoomState(next);
  };

  // The server (which owns hearts in co-op) reports a hit — from a monster or another player. We only
  // play the damage cue; the heart count itself arrives authoritatively in the next snapshot.
  runtime.applyHurt = function applyHurt(by: string): void {
    runtime.flashDamage();
    debug('engine', 'hurt', { by });
  };

  runtime.localPose = function localPose(): { x: number; y: number; z: number; yaw: number; pitch: number } {
    return { x: player.pos.x, y: player.pos.y, z: player.pos.z, yaw: player.yaw, pitch: player.pitch };
  };

  runtime.sendCoopEdit = function sendCoopEdit(op: EditOp, x: number, y: number, z: number, id: number): void {
    runtime.coop?.sendEdit(op, x, y, z, id);
  };

  runtime.debugSnapshot = function debugSnapshot(): DebugSnapshot {
    const { coop } = runtime;
    return buildDebugSnapshot({
      fps: state.fps,
      x: player.pos.x, y: player.pos.y, z: player.pos.z,
      chunks: runtime.chunkMeshes.size,
      tenant: brand.id,
      frontVersion: runtime.appVersion,
      coop: coop ? { ping: coop.ping, state: coop.state, onlineCount: coop.onlineCount, backendVersion: coop.backendVersion } : null,
    });
  };

  // Plain-text diagnostics the owner pastes when the online "can't break/hit but can build" bug strikes.
  // Live connection state + this player's client-vs-server position delta + the recent-events ring.
  runtime.debugReport = function debugReport(): string {
    const { coop } = runtime;
    const snapshot = runtime.debugSnapshot();
    return formatDebugReport({
      at: Date.now(),
      tenant: snapshot.tenant,
      frontVersion: snapshot.frontVersion,
      backendVersion: snapshot.backendVersion,
      netState: snapshot.state,
      ping: snapshot.ping,
      online: snapshot.online,
      clientPos: { x: player.pos.x, y: player.pos.y, z: player.pos.z },
      serverPos: coop ? coop.serverPos : null,
      hp: player.hearts,
      events: debugReportRing.list(),
    });
  };

  runtime.bindApi = function bindApi(): void {
    // Offline there is no server to echo an admin toggle back as a feed event, so build + route the same
    // FeedEvent locally — any admin config change shows in the feed in both modes.
    const offlineAdmin = (action: string): void => {
      if (!runtime.bridge) return;
      runtime.bridge.hud.onEvent(offlineAdminFeed({ name: runtime.bridge.resolveName(), action }));
    };
    runtime.bridge?.bind({
      sendChat: (text) => {
        if (!state.chatEnabled) return;
        if (runtime.coop) { runtime.coop.sendChat(text); return; }
        runtime.bridge?.hud.onChat(runtime.bridge.resolveName(), text);
      },
      setAdminPeace: (on) => {
        if (runtime.coop) { runtime.coop.sendAdminSetPeace(on); return; }
        runtime.applyLocalRoom({ ...runtime.currentRoom(), peace: on });
        offlineAdmin(on ? 'peace_on' : 'peace_off');
      },
      setAdminStructure: (kind, allowed) => {
        if (runtime.coop) { runtime.coop.sendAdminSetStructure(kind, allowed); return; }
        const blocked = new Set(runtime.blockedStructures);
        if (allowed) blocked.delete(kind); else blocked.add(kind);
        runtime.applyLocalRoom({ ...runtime.currentRoom(), blockedStructures: [...blocked] });
        offlineAdmin(allowed ? 'structure_allowed' : 'structure_blocked');
      },
      setAdminPvp: (on) => {
        if (runtime.coop) { runtime.coop.sendAdminSetPvp(on); return; }
        runtime.applyLocalRoom({ ...runtime.currentRoom(), pvp: on });
        offlineAdmin(on ? 'pvp_on' : 'pvp_off');
      },
      setAdminChat: (on) => {
        if (runtime.coop) { runtime.coop.sendAdminSetChat(on); return; }
        runtime.applyLocalRoom({ ...runtime.currentRoom(), chatEnabled: on });
        offlineAdmin(on ? 'chat_on' : 'chat_off');
      },
      kickPlayer: (id) => runtime.coop?.sendAdminKick(id),
      banPlayer: (id) => runtime.coop?.sendAdminBan(id),
      reportPlayer: (id) => runtime.coop?.sendAdminReport(id),
      resetWorld: () => {
        if (runtime.coop) { runtime.coop.sendAdminResetWorld(); return; }
        runtime.resetLocalWorld();
        runtime.bridge?.hud.onEvent(offlineResetFeed({ name: runtime.bridge.resolveName() }));
      },
      resetScores: () => runtime.coop?.sendAdminResetScores(),
      suspendRoom: (on) => runtime.coop?.sendAdminSuspend(on),
      setRole: (id, role) => runtime.coop?.sendAdminSetRole(id, role),
      setApprovalRequired: (on) => runtime.coop?.sendAdminSetApproval(on),
      approvePlayer: (accountId) => runtime.coop?.sendAdminApprove(accountId),
      rejectPlayer: (accountId) => runtime.coop?.sendAdminReject(accountId),
      banPending: (accountId) => runtime.coop?.sendAdminBanPending(accountId),
      unban: (ip) => runtime.coop?.sendAdminUnban(ip),
      setLimits: (min, hours) => runtime.coop?.sendAdminSetLimits(min, hours),
      setModes: (online, offline) => runtime.coop?.sendAdminSetModes(online, offline),
      chime: runtime.chime,
      setInfiniteResources: (on) => {
        if (runtime.coop) { runtime.coop.sendAdminSetInfinite(on); return; }
        state.infiniteResources = on;
        runtime.updateHotbarCounts();
      },
      returnToSpawn: () => {
        if (runtime.coop) { runtime.coop.sendRespawn(); return; }
        player.pos.copy(runtime.spawnPoint()); player.vel.set(0, 0, 0); runtime.savePos();
      },
      debugSnapshot: runtime.debugSnapshot,
      debugReport: runtime.debugReport,
    });
  };

  runtime.startCoop = function startCoop(): void {
    const serverUrl = runtime.serverUrl;
    if (runtime.coop) return;
    if (!serverUrl) { debug('coop', 'single-player (no server url)'); runtime.grantOfflineAdmin(); return; }
    if (!runtime.bridge) { debug('coop', 'single-player (no hud bridge)'); return; }
    if (runtime.bridge.resolveOffline()) {
      debug('coop', 'single-player (chosen)');
      runtime.enterOfflineMode();
      return;
    }
    const bridge = runtime.bridge;
    const name = bridge.resolveName();
    const look = bridge.resolveAppearance();
    const claim = bridge.resolveClaim(name);
    // The authoritative score arrives in every snapshot; paint it into the engine-owned topbar
    // (stars + record) before forwarding to the React HUD.
    const hud: CoopHud = {
      ...bridge.hud,
      onScore: (score) => {
        player.stars = score;
        runtime.recordServerScore(score);
        runtime.updateStats();
        bridge.hud.onScore(score);
      },
      onRole: (role) => bridge.hud.onRole(role),
    };
    runtime.coop = createCoop({
      view: runtime.coopView,
      url: serverUrl,
      tenant: brand.id,
      world: MAIN_WORLD,
      name,
      skin: look.skin,
      shirt: look.shirt,
      hair: look.hair,
      claim,
      hud,
      applyRemoteEdit: runtime.applyRemoteEdit,
      applyRemoteEditBatch: runtime.applyRemoteEditBatch,
      applyRoomState: runtime.applyRoomState,
      applyHurt: runtime.applyHurt,
      onCreaturePoof: ({ x, y, z, color }) => runtime.spawnPoof(new Vec3(x, y, z), color),
      onWorldReset: runtime.resetLocalWorld,
      onSpawn: (x, y, z) => { player.pos.set(x, y, z); player.vel.set(0, 0, 0); },
      onHealth: (hp) => {
        if (hp < player.hearts) runtime.flashDamage();
        player.hearts = hp;
        runtime.updateStats();
      },
      // A heart drop vanished within pickup range: play the collect cue the offline path plays, so a
      // pickup online always sounds — including at full health, when hp never changes.
      onHeartCollected: () => runtime.blip(990, 0.1),
      onRespawn: (x, y, z, hp) => {
        player.pos.set(x, y, z);
        player.vel.set(0, 0, 0);
        player.hearts = hp;
        runtime.updateStats();
        runtime.toast(t('toast.nap'));
      },
      // The server pushed this player's authoritative inventory (counts + infinite flag): repaint the
      // hotbar from it.
      onInventory: runtime.updateHotbarCounts,
    });
    debug('coop', 'connecting', { url: serverUrl, tenant: brand.id, name });
  };
}

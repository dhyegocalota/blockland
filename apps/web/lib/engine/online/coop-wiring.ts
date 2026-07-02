// Co-op wiring, dependency-inverted onto the shared GameRuntime: the remote-edit appliers, room-state
// sync, the hurt cue, the local pose/edit forwarders, the debug snapshot, the admin/GameApi bridge bind,
// and the createCoop call itself (startCoop). Both modes go through createCoop: online opens a socket;
// offline (single-player) drives the in-process WASM game-core, which IS the authority (the lone player
// joins as admin). So the admin/GameApi actions always route through the live `coop` controller in both
// modes — there is no separate TS offline authority anymore.
import { Vec3 } from '../vec3';
import { t } from '../../i18n';
import { debug } from '../../log';
import { AIR, EYE_HEIGHT } from '../constants';
import { blockById } from '../blocks';
import { clearFeetAbove } from '../actors';
import { buildDebugSnapshot, type DebugSnapshot } from '../debug-snapshot';
import { debugReportRing, formatDebugReport } from '../debug-report';
import { createCoop, MAIN_WORLD, type Appearance, type CoopHud, type CoopOptions, type RoomState } from '../../coop';
import { createWasmCoreNet, wasmOfflineConfig, wasmOfflineDebug, wasmOfflineSeed } from './wasm-core-source';
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
    const removed = runtime.getVoxel(x, y, z);
    // When the server confirms OUR own dig broke a block, that is when we collect it (digs are
    // server-authoritative now, so we wait for the break instead of applying it optimistically).
    if (mine && id === AIR && removed !== AIR) {
      player.bag += 1; runtime.inventory.bank(removed); runtime.updateHotbarCounts(); runtime.updateStats();
    }
    // Another player breaking a block: spawn the same colour-tinted puff they saw locally, so the break
    // splash shows for everyone (we already puffed our own digs in breakBlock).
    if (!mine && id === AIR && removed !== AIR) {
      const block = blockById(removed);
      if (block) runtime.spawnPoof(new Vec3(x + 0.5, y + 0.5, z + 0.5), block.color);
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
    // Every action routes through the live coop authority (the socket online, the WASM core offline). The
    // core echoes each admin toggle / reset / chat back as the same ServerMsg the socket does, so the feed,
    // room-state and HUD update identically in both modes — no separate local-offline path.
    runtime.bridge?.bind({
      sendChat: (text) => {
        if (!state.chatEnabled) return;
        runtime.coop?.sendChat(text);
      },
      setAdminPeace: (on) => runtime.coop?.sendAdminSetPeace(on),
      setAdminStructure: (kind, allowed) => runtime.coop?.sendAdminSetStructure(kind, allowed),
      setAdminPvp: (on) => runtime.coop?.sendAdminSetPvp(on),
      setAdminChat: (on) => runtime.coop?.sendAdminSetChat(on),
      kickPlayer: (id) => runtime.coop?.sendAdminKick(id),
      banPlayer: (id) => runtime.coop?.sendAdminBan(id),
      resetWorld: () => runtime.coop?.sendAdminResetWorld(),
      resetScores: () => runtime.coop?.sendAdminResetScores(),
      clearHistory: () => runtime.coop?.sendAdminClearHistory(),
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
      setInfiniteResources: (on) => runtime.coop?.sendAdminSetInfinite(on),
      setCursorOverlay: runtime.setCursorOverlay,
      returnToSpawn: () => runtime.coop?.sendRespawn(),
      debugSnapshot: runtime.debugSnapshot,
      debugReport: runtime.debugReport,
    });
  };

  // The shared createCoop options every coop source uses (online socket OR the offline wasm core). The
  // renderer/HUD/admin wiring below is identical for both — only `url`/`netFactory` differ — so a coop
  // session renders + admin-panels the same whether its `ServerMsg`s come from the wire or the local core.
  function coopOptions(args: { url: string; name: string; look: Appearance; claim: string; netFactory?: CoopOptions['netFactory'] }): CoopOptions {
    const bridge = runtime.bridge!;
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
    return {
      view: runtime.coopView,
      url: args.url,
      tenant: brand.id,
      world: MAIN_WORLD,
      name: args.name,
      skin: args.look.skin,
      shirt: args.look.shirt,
      hair: args.look.hair,
      claim: args.claim,
      hud,
      netFactory: args.netFactory,
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
        // Entering/leaving the death pause: hp 0 starts the first-person fall; any positive hp clears it.
        if (hp <= 0 && state.deadSince === null) state.deadSince = performance.now();
        if (hp > 0) state.deadSince = null;
        runtime.updateStats();
      },
      // A heart drop vanished within pickup range: play the collect cue the offline path plays, so a
      // pickup online always sounds — including at full health, when hp never changes.
      onHeartCollected: () => runtime.blip(990, 0.1),
      onRespawn: (x, y, z, hp) => {
        player.pos.set(x, y, z);
        player.vel.set(0, 0, 0);
        player.hearts = hp;
        state.deadSince = null;
        runtime.updateStats();
        runtime.toast(t('toast.nap'));
      },
      // The server pushed this player's authoritative inventory (counts + infinite flag): repaint the
      // hotbar from it.
      onInventory: runtime.updateHotbarCounts,
    };
  }

  // Offline-via-core: the single-player game runs on the local WasmCore (this is the DEFAULT offline
  // engine). The core IS the admin authority (the lone player joins as admin), so the SAME createCoop
  // wiring drives the renderer + admin panel — just sourced from the in-process core instead of a socket.
  function startWasmOffline(): void {
    const bridge = runtime.bridge!;
    const name = bridge.resolveName();
    const look = bridge.resolveAppearance();
    const config = wasmOfflineConfig({ tenant: brand.id, world: MAIN_WORLD, brand });
    const netFactory: CoopOptions['netFactory'] = (netOptions) => createWasmCoreNet({
      handlers: netOptions.handlers,
      name,
      look,
      init: { seed: wasmOfflineSeed(), config: JSON.stringify(config), debug: wasmOfflineDebug() },
    });
    runtime.coop = createCoop(coopOptions({ url: '', name, look, claim: '', netFactory }));
    debug('coop', 'offline-via-core (wasm)', { tenant: brand.id, name });
  }

  runtime.startCoop = function startCoop(): void {
    const serverUrl = runtime.serverUrl;
    if (runtime.coop) return;
    // No HUD bridge (the headless boot): nothing drives a lobby choice; a configured server still has
    // nothing to attach to here, so just log and return (the bridged boot is the real entry).
    if (!runtime.bridge) {
      if (serverUrl) debug('coop', 'single-player (no hud bridge)');
      else debug('coop', 'single-player (no hud bridge, no server url)');
      return;
    }
    // Offline now runs the WASM game-core BY DEFAULT — it IS the single-player engine. We go offline when
    // there is no server to reach, or the player chose single-player in the lobby.
    const wantsOffline = !serverUrl || runtime.bridge.resolveOffline();
    if (wantsOffline) { startWasmOffline(); return; }
    const bridge = runtime.bridge;
    const name = bridge.resolveName();
    const look = bridge.resolveAppearance();
    const claim = bridge.resolveClaim(name);
    runtime.coop = createCoop(coopOptions({ url: serverUrl, name, look, claim }));
    debug('coop', 'connecting', { url: serverUrl, tenant: brand.id, name });
  };
}

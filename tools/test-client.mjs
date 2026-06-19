// Minimal load/smoke client for the authoritative server. No deps (Node >= 22 has WebSocket).
//   node tools/test-client.mjs [count] [tenant] [world]
const URL = process.env.URL || 'ws://localhost:8080/ws';
const COUNT = Number(process.argv[2] || 3);
const TENANT = process.argv[3] || 'teo';
const WORLD = process.argv[4] || 'lobby';

const last = {}; // bot index -> last snapshot
function bot(i) {
  const ws = new WebSocket(URL);
  let me = null;
  let base = [8192.5, 12, 8192.5];
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ t: 'join', tenant: TENANT, world: WORLD, name: `Bot${i}` }));
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'welcome') {
      me = m.you;
      base = m.spawn;
      console.log(`bot${i} -> welcome id=${m.you} tenant=${m.tenant} brand=${m.brand.name}`);
      // Walk smoothly (~8 b/s, under the server speed cap) so moves are accepted.
      let px = base[0], pz = base[2], ang = i;
      setInterval(() => {
        ang += 0.15;
        px += Math.cos(ang) * 0.8;
        pz += Math.sin(ang) * 0.8;
        ws.send(JSON.stringify({ t: 'move', x: px, y: base[1], z: pz, yaw: ang, pitch: 0 }));
      }, 100);
      // And one blatant teleport to prove the anti-cheat rejects it.
      setTimeout(() => ws.send(JSON.stringify({ t: 'move', x: base[0] + 5000, y: base[1], z: base[2], yaw: 0, pitch: 0 })), 1500);
      // one build edit near spawn
      setTimeout(() => ws.send(JSON.stringify({
        t: 'edit', op: 'place', x: Math.round(base[0]) + i, y: Math.round(base[1]), z: Math.round(base[2]), id: 8,
      })), 500);
    }
    if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', nonce: m.nonce }));
    if (m.t === 'snapshot') last[i] = m;
    if (m.t === 'error') console.log(`bot${i} error:`, m.code, m.msg);
  });
  ws.addEventListener('close', () => console.log(`bot${i} closed`));
  ws.addEventListener('error', (e) => console.log(`bot${i} ws error`, e.message || e));
}

for (let i = 0; i < COUNT; i++) bot(i);
console.log(`spawned ${COUNT} bots -> ${URL} (${TENANT}/${WORLD})`);

// Self-contained verdict: report the world as bot0 sees it, then exit cleanly.
setTimeout(() => {
  const snap = last[0];
  if (!snap) {
    console.log('FALHOU: bot0 nunca recebeu snapshot');
    process.exit(1);
  }
  const moved = snap.players.filter((p) => Math.abs(p.x - 8192.5) > 0.5 || Math.abs(p.z - 8192.5) > 0.5).length;
  const pinged = snap.players.filter((p) => p.ping_ms > 0).length;
  console.log('--- VERDITO (visto pelo bot0 via socket do jogo) ---');
  console.log(`tick=${snap.tick} players=${snap.players.length}/${COUNT} moveram=${moved} com_ping=${pinged}`);
  for (const p of snap.players) {
    console.log(`  ${p.name} pos=(${p.x.toFixed(1)},${p.z.toFixed(1)}) yaw=${p.yaw.toFixed(2)} ping=${p.ping_ms}ms`);
  }
  process.exit(0);
}, 7000);

# 🧱 Blocklandia

Plataforma **white-label** de mundos de blocos 3D pra crianças: construir, caçar bichos, lutar contra monstros, juntar estrelas e voar. Cada cliente é um **tenant** com sua própria marca (nome, cores, avatar, foto-no-bloco). O primeiro tenant é o **Teocraft**, feito pro Teodoro.

## Monorepo

```
app/                Next.js (cliente do jogo, single-player) — hospedado na Vercel
lib/
  game-engine.js    engine do jogo (voxels, física, criaturas, construções) — brand-driven
  tenants.js        config white-label (Teocraft + demo); resolve por ?tenant=
public/             assets por tenant (ex.: /teo-face.png)
crates/             servidor multiplayer autoritativo (Rust)
  protocol/         tipos da wire (cliente <-> servidor)
  sim/              worldgen/voxel/colisão compartilháveis (futuro WASM no cliente)
  server/           tokio + axum: salas, tick 20Hz, anti-cheat, observabilidade
Dockerfile          build do servidor
docker-compose.yml  servidor local com limites de CPU/RAM
tools/test-client   bots de carga/smoke (Node, sem deps)
```

## Cliente (web) — Vercel

```bash
npm install
npm run dev     # http://localhost:3000
```

- Tenant padrão: **Teocraft** (`/`). Outro tenant: `/?tenant=demo`.
- Pra adicionar um cliente novo, adicione um tenant em `lib/tenants.js` (nome, cores, avatar, foto) — nada do Teo está embutido no core.

## Servidor multiplayer (Rust) — local com Docker

```bash
docker compose up --build game-server
node tools/test-client.mjs 4 teo lobby     # conecta 4 bots e imprime o veredito
curl -H "x-admin-token: dev-admin-secret" http://localhost:8080/admin/stats   # quem tá online, onde, ping
```

Características: servidor é a **fonte da verdade** (tick 20 Hz, valida velocidade/reach, rejeita teleporte), **≤10 players/sala**, salas isoladas por `(tenant, world)`, anti-abuso (token-bucket por player, limite por IP, idle timeout) e observabilidade (`/admin/stats`, `/healthz`, logs). Tenants e limites em `tenants.toml`.

> O netcode do cliente (predição + interpolação) e o port da `sim` pra WASM são as próximas fases — o servidor já está pronto e testado.

## ⌨️ Controles (também no jogo, tecla **V**)

| Ação | Como |
| --- | --- |
| Andar | Setas / W A S D · 📱 joystick |
| Pular · Voar | Espaço · F (voo segue a mira) |
| Olhar | Mouse · 📱 arrastar na tela |
| Quebrar / construir | Clique esquerdo / direito · 📱 botões ⛏️/🧱 |
| Escolher bloco | Teclas 1–9, 0, -, c, x, z, i, k, l, r, j |
| Construções mágicas | Tecla B (taça, bola, figurinha, refri, Steve) |
| Modo paz | Tecla P |

---

Feito com 💛 — começou como um Minecraft pro Teodoro e virou plataforma.

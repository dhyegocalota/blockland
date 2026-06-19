# 🎮 Teocraft — O Mundo do Teodoro

Um Minecraft em 3D feito com carinho pro **Teodoro** (6 anos). Ele é o herói do jogo: a cara dele vira bloco, tem um monumento de boas-vindas com o rosto dele no meio do mundo, e o avatar aparece na tela inicial.

Construído com **Next.js** + **three.js**. 100% no navegador, sem servidor de jogo.

## 🕹️ Jogar

Online (depois de publicado na Vercel): é só abrir o link.

Localmente:

```bash
npm install
npm run dev
```

Abra **http://localhost:3000** e clique em **▶ JOGAR**.

## 🎯 O que dá pra fazer

- 🧱 **Construir** castelos com 11 blocos (grama, pedra, madeira, ouro, arco-íris e o **bloco do Teo**)
- 🐷 **Caçar** porquinhos, galinhas e vaquinhas
- 👾 **Lutar** contra geleias e aranhas (eles perseguem!)
- 🕊️ **Modo Paz** pra deixar os monstros calminhos quando quiser (tecla **P**)
- ⭐ **Juntar estrelas** e bater o **🏆 recorde** (salvo no navegador)
- 🎒 **Coletar recursos** quebrando blocos
- ✈️ **Voar** pelo mundo todo

## ⌨️ Controles (também no jogo, tecla **V**)

| Ação | Como |
| --- | --- |
| Andar | Setas ou `W` `A` `S` `D` |
| Pular | Barra de espaço |
| Voar / pousar | Tecla `F` ou botão ✈️ |
| Olhar em volta | Mexer o mouse |
| Quebrar / bater | Clique esquerdo 🖱️ |
| Construir | Clique direito 🖱️ |
| Escolher bloco | Teclas `1`–`9`, `0` (bloco do Teo!) e `-` (água) |
| Modo paz (monstros calmos) | Tecla `P` ou botão ⚔️/🕊️ |
| Ver controles | Tecla `V` |

## 🗂️ Estrutura

```
app/
  layout.js        # metadata + viewport
  page.js          # renderiza o jogo
  Game.jsx         # HUD (telas, hotbar, modal de controles)
  globals.css      # estilo kid-friendly
lib/
  teocraft.js      # engine do jogo (voxels, física, criaturas, combate)
public/
  teo-face.png     # textura do bloco do Teo
  teo-avatar.png   # avatar / favicon
```

## ☁️ Deploy

Hospedado na **Vercel**. Cada push na branch principal gera um novo deploy automático.

---

Feito com 💛 pro Teodoro.

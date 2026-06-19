'use client';

import { useEffect } from 'react';

export default function Game() {
  useEffect(() => {
    let cleanup;
    import('../lib/teocraft').then((mod) => { cleanup = mod.initTeocraft(); });
    return () => { if (cleanup) cleanup(); };
  }, []);

  return (
    <>
      <div id="hud">
        <div id="topbar">
          <img src="/teo-avatar.png" alt="Teodoro" />
          <span className="title">Teocraft</span>
          <span className="stat" id="hearts">❤️❤️❤️</span>
          <span className="stat" id="stars">⭐ 0</span>
          <span className="stat record" id="record">🏆 0</span>
          <span className="stat" id="bag">🎒 0</span>
        </div>
        <div id="crosshair"></div>
        <div id="toast"></div>
        <div id="hotbar"></div>
        <div id="actionRow">
          <button className="btn" id="helpBtn">❓ Controles</button>
          <button className="btn" id="buildBtn">🏗️ Construir</button>
          <button className="btn" id="flyBtn">✈️ Voar</button>
          <button className="btn on" id="modeBtn">🕊️ Paz: ON</button>
        </div>
      </div>

      <div id="controls" hidden>
        <div className="panel">
          <h2>🎮 Controles do Teocraft</h2>
          <div className="ctrlGrid">
            <div className="card"><b>Andar</b> Setas ou W A S D</div>
            <div className="card"><b>Pular</b> Barra de espaço</div>
            <div className="card"><b>Voar / Pousar</b> Tecla F (ou botão ✈️)</div>
            <div className="card"><b>Olhar em volta</b> Mexa o mouse</div>
            <div className="card"><b>Quebrar / Bater</b> Clique esquerdo 🖱️</div>
            <div className="card"><b>Construir</b> Clique direito 🖱️</div>
            <div className="card"><b>Escolher bloco</b> Teclas 1 a 9, 0 e -</div>
            <div className="card"><b>Caçar 🐷</b> Bata nos bichos</div>
            <div className="card"><b>Lutar 👾</b> Bata nos monstros</div>
            <div className="card"><b>Coletar 🎒</b> Quebre blocos</div>
            <div className="card"><b>Bloco do Teo 😎</b> Tecla 0</div>
            <div className="card"><b>Modo paz 🕊️</b> Tecla P (monstros calmos)</div>
            <div className="card"><b>Construções 🏗️</b> Tecla B (taça e bola!)</div>
            <div className="card"><b>Ver controles</b> Tecla V</div>
          </div>
          <button id="closeControls">▶ Voltar a jogar</button>
        </div>
      </div>

      <div id="buildMenu" hidden>
        <div className="panel">
          <h2>🏗️ Construções Mágicas</h2>
          <p className="buildHint">Escolha uma e ela aparece bem na sua frente! ✨</p>
          <div className="buildGrid">
            <button className="buildCard" data-kind="trophy"><span className="emoji">🏆</span><span>Taça da Copa do Mundo</span></button>
            <button className="buildCard" data-kind="ball"><span className="emoji">⚽</span><span>Bola gigante da Copa 2026</span></button>
            <button className="buildCard" data-kind="figure"><span className="emoji">🧑‍🦱</span><span>Figurinha do Teo craque ⚽</span></button>
            <button className="buildCard" data-kind="cola"><span className="emoji">🥤</span><span>Refri gigante da Copa</span></button>
            <button className="buildCard" data-kind="steve"><span className="emoji">🧍</span><span>Estátua do Steve</span></button>
          </div>
          <button id="closeBuild">Fechar</button>
        </div>
      </div>

      <div id="start">
        <img className="avatar" src="/teo-avatar.png" alt="Teodoro" />
        <h1>TEO<span className="teo">CRAFT</span></h1>
        <p>O mundo mágico do <b>Teodoro</b>! Construa castelos, cace os porquinhos, derrote os monstrinhos e junte estrelas. Coloque o seu rosto em blocos pra deixar tudo do seu jeito! 🎉</p>
        <span className="record-badge" id="startRecord">🏆 Recorde: 0</span>
        <div id="help">
          <div className="card"><b>Andar</b> Setas ou W A S D</div>
          <div className="card"><b>Pular / Voar</b> Espaço / F</div>
          <div className="card"><b>Olhar</b> Mexa o mouse</div>
          <div className="card"><b>Construir</b> Clique direito</div>
          <div className="card"><b>Bater / Quebrar</b> Clique esquerdo</div>
          <div className="card"><b>Caçar 🐷</b> Bata nos bichos</div>
          <div className="card"><b>Lutar 👾</b> Bata nos monstros</div>
          <div className="card"><b>Trocar bloco</b> Teclas 1 a 9</div>
        </div>
        <button id="playBtn">▶ JOGAR</button>
      </div>
    </>
  );
}

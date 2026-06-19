'use client';

import { useEffect, useState } from 'react';
import { resolveTenant } from '../lib/tenants';
import { t } from '../lib/i18n';

export default function Game() {
  const [brand, setBrand] = useState(null);

  useEffect(() => {
    let cleanup;
    let alive = true;
    resolveTenant().then((active) => {
      if (!alive) return;
      setBrand(active);
      import('../lib/game-engine').then((mod) => { cleanup = mod.initGame(active); });
    });
    return () => { alive = false; if (cleanup) cleanup(); };
  }, []);

  if (!brand) return null;

  return (
    <>
      <div id="hud">
        <div id="topbar">
          <img src={brand.avatar} alt={brand.hero} />
          <span className="title">{brand.name}</span>
          <span className="stat" id="hearts">❤️❤️❤️</span>
          <span className="stat" id="stars">⭐ 0</span>
          <span className="stat record" id="record">🏆 0</span>
          <span className="stat" id="bag">🎒 0</span>
        </div>
        <div id="crosshair"></div>
        <div id="toast"></div>
        <div id="hotbar"></div>
        <div id="actionRow">
          <button className="btn" id="helpBtn">{t('hud.controls')}</button>
          <button className="btn" id="buildBtn">{t('hud.build')}</button>
          <button className="btn" id="flyBtn">{t('hud.fly')}</button>
          <button className="btn on" id="modeBtn">{t('hud.peace_on')}</button>
        </div>
      </div>

      <div id="touchControls" style={{ display: 'none' }}>
        <div id="joystick"><div id="joyKnob"></div></div>
        <div id="touchButtons">
          <button id="btnUp" className="tbtn">⤴️</button>
          <button id="btnDown" className="tbtn">⤵️</button>
          <button id="btnPlace" className="tbtn place">🧱</button>
          <button id="btnBreak" className="tbtn break">⛏️</button>
        </div>
      </div>

      <div id="controls" hidden>
        <div className="panel">
          <h2>{t('controls.title')}</h2>
          <div className="ctrlGrid">
            <div className="card"><b>{t('controls.move')}</b> {t('controls.move_keys')}</div>
            <div className="card"><b>{t('controls.jump')}</b> {t('controls.jump_keys')}</div>
            <div className="card"><b>{t('controls.fly_land')}</b> {t('controls.fly_land_keys')}</div>
            <div className="card"><b>{t('controls.look')}</b> {t('controls.look_keys')}</div>
            <div className="card"><b>{t('controls.break')}</b> {t('controls.break_keys')}</div>
            <div className="card"><b>{t('controls.build')}</b> {t('controls.build_keys')}</div>
            <div className="card"><b>{t('controls.pick_block')}</b> {t('controls.pick_block_keys')}</div>
            <div className="card"><b>{t('controls.hunt')}</b> {t('controls.hunt_keys')}</div>
            <div className="card"><b>{t('controls.fight')}</b> {t('controls.fight_keys')}</div>
            <div className="card"><b>{t('controls.collect')}</b> {t('controls.collect_keys')}</div>
            <div className="card"><b>{t('controls.your_face')}</b> {t('controls.your_face_keys')}</div>
            <div className="card"><b>{t('controls.peace_mode')}</b> {t('controls.peace_mode_keys')}</div>
            <div className="card"><b>{t('controls.structures')}</b> {t('controls.structures_keys')}</div>
            <div className="card"><b>{t('controls.show_controls')}</b> {t('controls.show_controls_keys')}</div>
          </div>
          <button id="closeControls">{t('controls.back_to_game')}</button>
        </div>
      </div>

      <div id="buildMenu" hidden>
        <div className="panel">
          <h2>{t('build.menu_title')}</h2>
          <p className="buildHint">{t('build.menu_hint')}</p>
          <div className="buildGrid">
            <button className="buildCard" data-kind="trophy"><span className="emoji">🏆</span><span>{t('build.trophy')}</span></button>
            <button className="buildCard" data-kind="ball"><span className="emoji">⚽</span><span>{t('build.ball')}</span></button>
            <button className="buildCard" data-kind="figure"><span className="emoji">🧑‍🦱</span><span>{t('build.figure')}</span></button>
            <button className="buildCard" data-kind="cola"><span className="emoji">🥤</span><span>{t('build.cola')}</span></button>
            <button className="buildCard" data-kind="steve"><span className="emoji">🧍</span><span>{t('build.steve')}</span></button>
          </div>
          <button id="closeBuild">{t('build.close')}</button>
        </div>
      </div>

      <div id="start">
        <img className="avatar" src={brand.avatar} alt={brand.hero} />
        <h1>{brand.titleA}<span className="accent">{brand.titleB}</span></h1>
        <p dangerouslySetInnerHTML={{ __html: brand.tagline }} />
        <span className="record-badge" id="startRecord">{t('start.record')}</span>
        <div id="help">
          <div className="card"><b>{t('controls.move')}</b> {t('controls.move_keys')}</div>
          <div className="card"><b>{t('start.jump_fly')}</b> {t('start.jump_fly_keys')}</div>
          <div className="card"><b>{t('start.look')}</b> {t('controls.look_keys')}</div>
          <div className="card"><b>{t('start.build')}</b> {t('start.build_keys')}</div>
          <div className="card"><b>{t('start.hit_break')}</b> {t('start.hit_break_keys')}</div>
          <div className="card"><b>{t('controls.hunt')}</b> {t('controls.hunt_keys')}</div>
          <div className="card"><b>{t('controls.fight')}</b> {t('controls.fight_keys')}</div>
          <div className="card"><b>{t('start.swap_block')}</b> {t('start.swap_block_keys')}</div>
        </div>
        <button id="playBtn">{t('start.play')}</button>
      </div>
    </>
  );
}

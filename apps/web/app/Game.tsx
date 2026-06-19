'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveTenant, type Brand } from '../lib/tenants';
import { t } from '../lib/i18n';
import { debug, warn } from '../lib/log';
import type { CoopBridge, DebugSnapshot } from '../lib/game-engine';
import type { NetState } from '../lib/net';

const NAME_KEY = 'bl-name';
const CHAT_BACKLOG = 6;
const CHAT_FADE_MS = 8000;

const BANNER_KEYS: Record<NetState, string | null> = {
  connecting: 'coop.connecting',
  online: null,
  reconnecting: 'coop.reconnecting',
  offline: 'coop.offline',
  banned: 'coop.banned',
  kicked: 'coop.kicked',
  room_closed: 'coop.room_closed',
};

const SEVERE_STATES: NetState[] = ['banned', 'kicked', 'room_closed'];

function generateGuestName(): string {
  return `Guest${Math.floor(1000 + Math.random() * 9000)}`;
}

function loadName(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(NAME_KEY) ?? '';
}

interface ChatLine {
  id: number;
  name: string;
  text: string;
}

interface GameApi {
  sendChat(text: string): void;
  debugSnapshot(): DebugSnapshot;
}

export default function Game() {
  const [brand, setBrand] = useState<Brand | null>(null);
  const [failed, setFailed] = useState(false);
  const [offline, setOffline] = useState(false);
  const [offlineDismissed, setOfflineDismissed] = useState(false);
  const [name, setName] = useState(loadName);
  const [netState, setNetState] = useState<NetState | null>(null);
  const [ping, setPing] = useState(0);
  const [online, setOnline] = useState(1);
  const [chatLines, setChatLines] = useState<ChatLine[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatDraft, setChatDraft] = useState('');
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugData, setDebugData] = useState<DebugSnapshot | null>(null);

  const gameApiRef = useRef<GameApi | null>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const chatLineId = useRef(0);

  const pushChatLine = useCallback((from: string, text: string) => {
    const id = chatLineId.current++;
    setChatLines((lines) => [...lines, { id, name: from, text }].slice(-CHAT_BACKLOG));
    setTimeout(() => setChatLines((lines) => lines.filter((line) => line.id !== id)), CHAT_FADE_MS);
  }, []);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let alive = true;
    resolveTenant()
      .then(({ tenant: active, offline: isOffline }) => {
        if (!alive) return;
        debug('tenant', 'active tenant', { id: active.id, name: active.name, offline: isOffline });
        setBrand(active);
        setOffline(isOffline);
        const bridge: CoopBridge = {
          resolveName: () => loadName().trim() || generateGuestName(),
          hud: {
            onState: (state) => setNetState(state),
            onPing: (value) => setPing(value),
            onChat: (from, text) => pushChatLine(from, text),
            onCount: (count) => setOnline(count),
          },
          bind: (api) => { gameApiRef.current = api; },
        };
        import('../lib/game-engine').then((mod) => {
          debug('engine', 'engine module loaded', { id: active.id, name: active.name });
          cleanup = mod.initGame(active, bridge);
        });
      })
      .catch((err) => {
        if (!alive) return;
        warn('tenant', 'failed to load tenant', { error: String(err) });
        setFailed(true);
      });
    return () => { alive = false; if (cleanup) cleanup(); };
  }, [pushChatLine]);

  const openChat = useCallback(() => {
    setChatOpen(true);
    requestAnimationFrame(() => chatInputRef.current?.focus());
  }, []);

  const sendChat = useCallback(() => {
    const text = chatDraft.trim();
    if (text) gameApiRef.current?.sendChat(text);
    setChatDraft('');
    setChatOpen(false);
  }, [chatDraft]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.code === 'F3') { event.preventDefault(); setDebugOpen((open) => !open); return; }
      if (chatOpen) return;
      const typingTarget = event.target instanceof HTMLInputElement;
      if (typingTarget) return;
      if (event.code === 'Enter' || event.code === 'KeyT') { event.preventDefault(); openChat(); }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [chatOpen, openChat]);

  useEffect(() => {
    if (!debugOpen) return;
    let rafId = 0;
    const tick = (): void => {
      const api = gameApiRef.current;
      if (api) setDebugData(api.debugSnapshot());
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [debugOpen]);

  function onNameChange(value: string): void {
    setName(value);
    if (typeof window !== 'undefined') window.localStorage.setItem(NAME_KEY, value);
  }

  if (failed) return <div id="loadError">{t('error.connect')}</div>;
  if (!brand) return null;

  const bannerKey = netState ? BANNER_KEYS[netState] : null;
  const severe = netState ? SEVERE_STATES.includes(netState) : false;
  const showPing = netState === 'online';

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
          {showPing && <span className="stat" id="ping">{t('coop.ping', { ping })}</span>}
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

      {bannerKey && (
        <div id="netBanner" className={severe ? 'severe' : undefined} role="status">{t(bannerKey)}</div>
      )}

      {offline && !offlineDismissed && (
        <div id="offlineNotice" role="dialog" aria-modal="true">
          <div className="panel">
            <h2>{t('offline.title')}</h2>
            <p>{t('offline.body')}</p>
            <button id="offlinePlay" onClick={() => setOfflineDismissed(true)}>{t('offline.play')}</button>
          </div>
        </div>
      )}

      <div id="chat">
        <div id="chatLog">
          {chatLines.map((line) => (
            <div className="chatLine" key={line.id}>{t('chat.line', { name: line.name, text: line.text })}</div>
          ))}
        </div>
        {chatOpen && (
          <input
            id="chatInput"
            ref={chatInputRef}
            value={chatDraft}
            placeholder={t('chat.placeholder')}
            onChange={(e) => setChatDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.code === 'Enter') { e.preventDefault(); sendChat(); }
              if (e.code === 'Escape') { e.preventDefault(); setChatDraft(''); setChatOpen(false); }
            }}
          />
        )}
      </div>

      {debugOpen && debugData && (
        <div id="debugPanel">
          <h3>{t('debug.title')}</h3>
          <div><span>{t('debug.fps')}</span><b>{debugData.fps}</b></div>
          <div><span>{t('debug.ping')}</span><b>{debugData.ping}ms</b></div>
          <div><span>{t('debug.state')}</span><b>{debugData.state}</b></div>
          <div><span>{t('debug.online')}</span><b>{debugData.online}</b></div>
          <div><span>{t('debug.pos')}</span><b>{debugData.x}, {debugData.y}, {debugData.z}</b></div>
          <div><span>{t('debug.chunks')}</span><b>{debugData.chunks}</b></div>
          <div><span>{t('debug.tenant')}</span><b>{debugData.tenant}</b></div>
        </div>
      )}

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
        <label id="nameField">
          {t('start.name_label')}
          <input
            id="nameInput"
            value={name}
            maxLength={16}
            placeholder={t('start.name_placeholder')}
            onChange={(e) => onNameChange(e.target.value)}
          />
        </label>
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

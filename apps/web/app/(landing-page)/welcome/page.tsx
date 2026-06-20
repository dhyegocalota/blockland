'use client';

// Offer landing aimed at parents: sells the safety of a private, parent-approved voxel world and
// captures pre-launch interest into the waitlist (POST /api/waitlist). Reached directly, and where
// the admin panel used to refuse a tenant subdomain it redirects here. Visually it echoes the
// in-game lobby (#start in globals.css): blue sky, drifting clouds, a green hill and chunky blocks.
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import Script from 'next/script';
import { currentLocale } from '../../../lib/i18n';
import { PLATFORM_NAME } from '../../../lib/builtins';
import { COPY, isEmailValid } from './copy';

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const DEMO_URL = 'https://demo.blockland.dhyegocalota.com.br';

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        options: { sitekey: string; callback: (token: string) => void; 'expired-callback': () => void },
      ) => string;
    };
  }
}

type Status = 'idle' | 'submitting' | 'done' | 'error';

// Cloudflare Turnstile widget. Renders explicitly once the script is ready and hands the verified
// token up so the form can submit it. Only mounted when a site key is configured.
function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (token: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);

  function renderWidget() {
    if (mounted.current || !box.current || !window.turnstile) return;
    mounted.current = true;
    window.turnstile.render(box.current, {
      sitekey: siteKey,
      callback: onToken,
      'expired-callback': () => onToken(''),
    });
  }

  useEffect(() => {
    renderWidget();
  });

  return (
    <>
      <Script src={TURNSTILE_SCRIPT} onLoad={renderWidget} />
      <div ref={box} style={S.turnstile} />
    </>
  );
}

export default function Welcome() {
  const copy = COPY[currentLocale()];
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [status, setStatus] = useState<Status>('idle');

  const needsToken = Boolean(TURNSTILE_SITE_KEY) && turnstileToken.length === 0;
  const canSubmit = status !== 'submitting' && !needsToken && isEmailValid(email);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setStatus('submitting');
    const res = await fetch('/api/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, name, phone, turnstileToken }),
    }).catch(() => null);
    if (!res || !res.ok) {
      setStatus('error');
      return;
    }
    setStatus('done');
  }

  return (
    <main style={S.wrap}>
      <style>{SKY_CSS}</style>
      <div style={S.sky} aria-hidden>
        <span style={{ ...S.cloud, ...S.cloudA }}>☁️</span>
        <span style={{ ...S.cloud, ...S.cloudB }}>☁️</span>
        <span style={{ ...S.cloud, ...S.cloudC }}>☁️</span>
      </div>
      <div style={S.hill} aria-hidden />
      <div style={S.stage}>
        <section style={{ ...S.hero, ...popIn(0) }}>
          <span style={S.badge}>{copy.badge}</span>
          <div style={S.heroCube} aria-hidden>🧱</div>
          <h1 style={S.brand}>{PLATFORM_NAME}</h1>
          <h2 style={S.headline}>{copy.headline}</h2>
          <p style={S.subhead}>{copy.subhead}</p>
          <div style={S.heroCtas}>
            <a style={S.heroCta} href="#waitlist">{copy.heroCta} →</a>
            <a style={S.demoCta} href={DEMO_URL} target="_blank" rel="noopener noreferrer">{copy.demoCta}</a>
          </div>
          <p style={S.demoNote}>{copy.demoNote}</p>
        </section>

        <section style={{ ...S.problem, ...popIn(1) }}>
          <h3 style={S.problemTitle}>{copy.problemTitle}</h3>
          {copy.problem.map((line) => (
            <p key={line} style={S.problemLine}>{line}</p>
          ))}
        </section>

        <section style={{ ...S.block, ...popIn(2) }}>
          <h3 style={S.sectionTitle}>{copy.valueTitle}</h3>
          <ul style={S.valueGrid}>
            {copy.valueStack.map((benefit) => (
              <li key={benefit.text} style={S.valueCard}>
                <span style={S.valueEmoji}>{benefit.emoji}</span>
                <span style={S.valueText}>{benefit.text}</span>
              </li>
            ))}
          </ul>
        </section>

        <section style={{ ...S.block, ...popIn(3) }}>
          <h3 style={S.sectionTitle}>{copy.objectionsTitle}</h3>
          <div style={S.objections}>
            {copy.objections.map((item) => (
              <div key={item.q} style={S.objectionCard}>
                <p style={S.objectionQ}>{item.q}</p>
                <p style={S.objectionA}>{item.a}</p>
              </div>
            ))}
          </div>
        </section>

        <p style={{ ...S.guarantee, ...popIn(4) }}>🛡️ {copy.guarantee}</p>

        <section style={{ ...S.founder, ...popIn(5) }}>
          <img
            src="/founder-family.jpg"
            alt={copy.founderSign}
            style={S.founderPhoto}
            onError={(event) => { event.currentTarget.style.display = 'none'; }}
          />
          <div style={S.founderText}>
            <h3 style={S.founderHeading}>{copy.founderTitle}</h3>
            {copy.founderStory.map((line) => (
              <p key={line} style={S.founderLine}>{line}</p>
            ))}
            <p style={S.founderSign}>{copy.founderSign}</p>
          </div>
        </section>

        <section id="waitlist" style={{ ...S.formSection, ...popIn(6) }}>
          <h3 style={S.formTitle}>{copy.formTitle}</h3>
          {status === 'done' && <p style={S.success}>{copy.success}</p>}
          {status !== 'done' && (
            <>
              <p style={S.formLead}>{copy.formLead}</p>
              <form style={S.form} onSubmit={submit}>
                <label style={S.label}>
                  {copy.emailLabel}
                  <input
                    style={S.input}
                    type="email"
                    required
                    value={email}
                    placeholder={copy.emailPlaceholder}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <label style={S.label}>
                  {copy.phoneLabel}
                  <input
                    style={S.input}
                    type="tel"
                    value={phone}
                    placeholder={copy.phonePlaceholder}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </label>
                <label style={S.label}>
                  {copy.nameLabel}
                  <input
                    style={S.input}
                    type="text"
                    value={name}
                    placeholder={copy.namePlaceholder}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                {TURNSTILE_SITE_KEY && <Turnstile siteKey={TURNSTILE_SITE_KEY} onToken={setTurnstileToken} />}
                <button style={canSubmit ? S.submit : S.submitDisabled} type="submit" disabled={!canSubmit}>
                  {status === 'submitting' ? copy.submitting : copy.submit}
                </button>
                {status === 'error' && <p style={S.error}>{copy.errorMsg}</p>}
              </form>
            </>
          )}
        </section>

        <section style={{ ...S.block, ...popIn(7) }}>
          <h3 style={S.sectionTitle}>{copy.faqTitle}</h3>
          <div style={S.faq}>
            {copy.faq.map((item) => (
              <div key={item.q} style={S.faqItem}>
                <p style={S.faqQ}>{item.q}</p>
                <p style={S.faqA}>{item.a}</p>
              </div>
            ))}
          </div>
        </section>

        <footer style={S.footer}>
          <div style={S.legalLinks}>
            <a style={S.legalLink} href="/terms">{copy.terms}</a>
            <span style={S.legalDot}>·</span>
            <a style={S.legalLink} href="/privacy">{copy.privacy}</a>
          </div>
          <a style={S.credit} href="https://dhyegocalota.com.br" target="_blank" rel="noopener noreferrer">
            {copy.credit}
          </a>
          <p style={S.company}>{copy.companyLine}</p>
          <p style={S.company}>{copy.addressLine}</p>
        </footer>
      </div>
    </main>
  );
}

function popIn(index: number): CSSProperties {
  return { animation: 'bl-pop .55s cubic-bezier(.2,1.4,.5,1) both', animationDelay: `${index * 0.09}s` };
}

const SKY_CSS = `
@keyframes bl-pop { from { transform: scale(0) rotate(-6deg); opacity: 0; } to { transform: scale(1) rotate(0); opacity: 1; } }
@keyframes bl-bob { 0%,100% { transform: translateY(0) rotate(-4deg); } 50% { transform: translateY(-12px) rotate(4deg); } }
@keyframes bl-drift { from { transform: translateX(0); } to { transform: translateX(150vw); } }
`;

// A reusable blocky "block" card: thick white border + a hard ink offset shadow (no soft blur),
// haloed in gold — echoing the lobby's .btn and panels.
const block: CSSProperties = {
  background: '#ffffffee', borderRadius: 24, padding: '28px 26px', maxWidth: 640, width: '100%',
  border: '6px solid #fff', boxShadow: '0 8px 0 #2a1a4a, 0 8px 0 4px #ffd23f', position: 'relative',
};

const S: Record<string, CSSProperties> = {
  wrap: {
    position: 'relative', minHeight: '100vh', overflow: 'hidden',
    background:
      'radial-gradient(120% 90% at 50% 6%, #ffffff55, transparent 42%),' +
      'radial-gradient(circle at 50% 22%, #bfeaff, #7ec8ff 58%, #3f9bdf 100%)',
    fontFamily: "'Baloo 2', 'Comic Sans MS', system-ui, sans-serif", color: '#2a1a4a',
  },
  sky: { position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none', overflow: 'hidden' },
  cloud: { position: 'absolute', filter: 'drop-shadow(0 8px 14px #0a4a7a22)', animation: 'bl-drift linear infinite' },
  cloudA: { top: '8%', left: '-18%', fontSize: 'clamp(40px, 12vw, 96px)', opacity: 0.85, animationDuration: '46s' },
  cloudB: { top: '22%', left: '-28%', fontSize: 'clamp(28px, 8vw, 64px)', opacity: 0.6, animationDuration: '62s', animationDelay: '-18s' },
  cloudC: { top: '4%', left: '-22%', fontSize: 'clamp(34px, 10vw, 78px)', opacity: 0.7, animationDuration: '54s', animationDelay: '-34s' },
  hill: {
    position: 'fixed', left: 0, right: 0, bottom: 0, height: '26vh', zIndex: 0, pointerEvents: 'none', opacity: 0.92,
    background:
      'radial-gradient(120% 100% at 18% 100%, #5cc35c 0 40%, transparent 41%),' +
      'radial-gradient(120% 100% at 82% 100%, #57bd57 0 38%, transparent 39%),' +
      'linear-gradient(to top, #6bd06b 0 22%, transparent 60%)',
  },
  stage: {
    position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22,
    padding: '34px 20px 56px',
  },
  hero: { ...block, textAlign: 'center', padding: '34px 28px', background: '#fffffff2' },
  badge: {
    display: 'inline-block', background: '#2a1a4a', color: '#ffd23f', fontWeight: 900, fontSize: 14,
    padding: '6px 16px', borderRadius: 999, letterSpacing: 0.5,
  },
  heroCube: {
    fontSize: 'clamp(54px, 14vw, 84px)', lineHeight: 1, margin: '14px 0 2px',
    animation: 'bl-bob 3s ease-in-out infinite', filter: 'drop-shadow(0 10px 0 #2a1a4a33)',
  },
  brand: {
    fontSize: 'clamp(44px, 12vw, 84px)', fontWeight: 900, color: '#fff', lineHeight: 0.95, margin: '4px 0 0',
    textShadow: '0 6px 0 #2a1a4a, 0 0 26px #ffd23f', letterSpacing: 1,
  },
  headline: { fontSize: 'clamp(22px, 5vw, 34px)', fontWeight: 900, lineHeight: 1.15, margin: '16px 0 0' },
  subhead: { fontSize: 'clamp(15px, 3.4vw, 19px)', fontWeight: 700, color: '#42365a', marginTop: 14, lineHeight: 1.5 },
  heroCtas: { display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center', marginTop: 22 },
  heroCta: {
    display: 'inline-block', background: 'linear-gradient(#ff8a3d, #ff5d2e)', color: '#fff',
    fontWeight: 900, fontSize: 'clamp(17px, 4vw, 21px)', textDecoration: 'none', padding: '15px 32px',
    borderRadius: 18, border: '5px solid #fff', boxShadow: '0 6px 0 #c43d18',
  },
  demoCta: {
    display: 'inline-block', background: 'linear-gradient(#b6f5b6, #6bd06b)', color: '#1c3a1c',
    fontWeight: 900, fontSize: 'clamp(16px, 3.6vw, 19px)', textDecoration: 'none', padding: '15px 28px',
    borderRadius: 18, border: '5px solid #fff', boxShadow: '0 6px 0 #3f9b3f',
  },
  demoNote: { fontSize: 13, fontWeight: 800, color: '#3f9b3f', marginTop: 12 },
  problem: {
    ...block, background: '#2a1a4af2', border: '6px solid #ffd23f', color: '#fff', textAlign: 'center',
    boxShadow: '0 8px 0 #1a1030',
  },
  problemTitle: { fontSize: 'clamp(20px, 4.6vw, 28px)', fontWeight: 900, color: '#ffd23f', margin: 0 },
  problemLine: { fontSize: 'clamp(15px, 3.4vw, 18px)', fontWeight: 700, lineHeight: 1.5, marginTop: 14, color: '#eef0ff' },
  block: { ...block },
  sectionTitle: { fontSize: 'clamp(22px, 5vw, 30px)', fontWeight: 900, textAlign: 'center', margin: '0 0 18px' },
  valueGrid: {
    listStyle: 'none', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
    gap: 12, margin: 0, padding: 0,
  },
  valueCard: {
    display: 'flex', gap: 12, alignItems: 'flex-start', background: '#f1f6ff', borderRadius: 16,
    padding: '14px 16px', border: '3px solid #d7e8ff', boxShadow: '0 4px 0 #c2dbff',
  },
  valueEmoji: { fontSize: 26, lineHeight: 1 },
  valueText: { fontWeight: 800, fontSize: 15, lineHeight: 1.35 },
  objections: { display: 'grid', gap: 12 },
  objectionCard: { background: '#fff7e6', borderRadius: 16, padding: '16px 18px', border: '3px solid #ffe9a8', boxShadow: '0 4px 0 #f3d77e' },
  objectionQ: { fontWeight: 900, fontSize: 17, margin: 0, color: '#ff5d2e' },
  objectionA: { fontWeight: 600, fontSize: 15, lineHeight: 1.5, color: '#42365a', marginTop: 8 },
  guarantee: {
    maxWidth: 640, width: '100%', textAlign: 'center', background: '#ffd23f', borderRadius: 20,
    padding: '18px 22px', fontWeight: 800, fontSize: 'clamp(15px, 3.4vw, 18px)', lineHeight: 1.45,
    border: '5px solid #fff', boxShadow: '0 8px 0 #d9a400',
  },
  formSection: { ...block, textAlign: 'center', border: '6px solid #ff5d2e', boxShadow: '0 8px 0 #c43d18' },
  formTitle: { fontSize: 'clamp(20px, 4.6vw, 28px)', fontWeight: 900, margin: 0 },
  formLead: { fontSize: 15, fontWeight: 700, color: '#42365a', marginTop: 12, lineHeight: 1.5 },
  form: { display: 'grid', gap: 14, marginTop: 18, textAlign: 'left' },
  label: { display: 'grid', gap: 6, fontWeight: 800, fontSize: 14 },
  input: {
    fontFamily: 'inherit', fontSize: 16, fontWeight: 700, color: '#2a1a4a', padding: '12px 14px',
    borderRadius: 14, border: '3px solid #cfe0f5', background: '#fff', outline: 'none',
  },
  turnstile: { display: 'flex', justifyContent: 'center', minHeight: 65 },
  submit: {
    marginTop: 4, background: 'linear-gradient(#ff8a3d, #ff5d2e)', color: '#fff', fontFamily: 'inherit',
    fontWeight: 900, fontSize: 20, padding: '15px 24px', borderRadius: 18, border: '5px solid #fff',
    boxShadow: '0 6px 0 #c43d18', cursor: 'pointer',
  },
  submitDisabled: {
    marginTop: 4, background: '#cdd4e0', color: '#7c8398', fontFamily: 'inherit',
    fontWeight: 900, fontSize: 20, padding: '15px 24px', borderRadius: 18, border: '5px solid #fff',
    boxShadow: 'none', cursor: 'not-allowed', opacity: 0.7,
  },
  success: { fontSize: 'clamp(16px, 3.6vw, 19px)', fontWeight: 800, lineHeight: 1.5, color: '#2a1a4a', marginTop: 16 },
  error: { fontWeight: 800, color: '#c43d18', fontSize: 15, marginTop: 4 },
  faq: { display: 'grid', gap: 12 },
  faqItem: { background: '#f1f6ff', borderRadius: 16, padding: '14px 16px', textAlign: 'left', border: '3px solid #d7e8ff', boxShadow: '0 4px 0 #c2dbff' },
  faqQ: { fontWeight: 900, fontSize: 16, margin: 0 },
  faqA: { fontWeight: 600, fontSize: 14, lineHeight: 1.5, color: '#42365a', marginTop: 6 },
  founder: {
    ...block, display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center',
  },
  founderPhoto: {
    width: 'clamp(150px, 38vw, 210px)', aspectRatio: '3 / 4', borderRadius: 20,
    objectFit: 'cover', border: '5px solid #ffd23f', boxShadow: '0 8px 0 #d9a400', flexShrink: 0,
  },
  founderText: { flex: 1, minWidth: 240 },
  founderHeading: { fontSize: 'clamp(20px, 4.6vw, 28px)', fontWeight: 900, margin: '0 0 6px' },
  founderLine: { fontSize: 'clamp(15px, 3.4vw, 17px)', fontWeight: 700, lineHeight: 1.55, color: '#42365a', marginTop: 12 },
  founderSign: { fontSize: 15, fontWeight: 900, color: '#ff5d2e', marginTop: 16 },
  footer: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginTop: 6 },
  legalLinks: { display: 'flex', gap: 8, alignItems: 'center' },
  legalLink: { color: '#15315c', fontWeight: 900, textDecoration: 'none', fontSize: 14 },
  legalDot: { color: '#15315c88' },
  credit: { color: '#15315ccc', fontWeight: 800, fontSize: 13, textDecoration: 'none' },
  company: { color: '#15315caa', fontWeight: 700, fontSize: 12, textAlign: 'center', margin: 0, lineHeight: 1.4 },
};

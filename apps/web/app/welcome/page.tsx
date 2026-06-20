'use client';

// Offer landing aimed at parents: sells the safety of a private, parent-approved voxel world and
// captures pre-launch interest into the waitlist (POST /api/waitlist). Reached directly, and where
// the admin panel used to refuse a tenant subdomain it redirects here.
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import Script from 'next/script';
import { currentLocale } from '../../lib/i18n';
import { PLATFORM_NAME } from '../../lib/builtins';

const CONTACT_EMAIL = 'dhyego@logicbit.com.br';
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

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

interface Benefit {
  emoji: string;
  text: string;
}

interface Qa {
  q: string;
  a: string;
}

const COPY = {
  'pt-BR': {
    badge: '🔒 Pré-lançamento',
    headline: 'Seu filho brinca online com os amigos — e você sabe exatamente quem está do outro lado.',
    subhead:
      'Mundo de blocos 3D estilo Minecraft, multiplayer: sem estranhos, sem chat tóxico, sem anúncio e sem compra escondida. Abre no navegador e você controla pelo seu celular.',
    heroCta: 'Quero garantir minha vaga',
    problemTitle: 'A vontade dele de brincar não devia custar o seu sossego',
    problem: [
      'Você já travou na hora de deixar seu filho entrar num jogo online. Não pelo jogo — pelo desconhecido do outro lado da tela.',
      'Estranho puxando assunto. Chat que você não controla. “Compre agora” piscando pra uma criança de 8 anos.',
    ],
    valueTitle: 'O que você ganha',
    valueStack: [
      { emoji: '🔒', text: 'Mundo fechado: só entra quem você aprova. Sem estranhos, ponto final.' },
      { emoji: '💬', text: 'Sem chat tóxico: nada de mensagem de gente que você não conhece.' },
      { emoji: '🚫', text: 'Sem anúncio e sem compra escondida: zero loot box, zero susto na fatura.' },
      { emoji: '👀', text: 'Você no controle: aprova os amigos e acompanha tudo pelo seu celular.' },
      { emoji: '👫', text: 'Brinca junto de verdade: primos e colegas no mesmo mundo, ao vivo.' },
      { emoji: '🌐', text: 'Sem download: abre no navegador e instala no celular ou tablet em segundos.' },
      { emoji: '🧱', text: 'Diversão que constrói: cria, explora, caça monstrinhos e junta estrelas.' },
    ] as Benefit[],
    objectionsTitle: 'Ainda na dúvida?',
    objections: [
      {
        q: 'Roblox é de graça, por que pagar?',
        a: 'De graça você paga em preocupação: estranhos, chat aberto e gastos surpresa no cartão. Aqui o preço de um lanche por mês compra o seu sossego — e nenhuma cobrança extra te pega de surpresa.',
      },
      {
        q: 'Meu filho já joga outro game.',
        a: 'Ótimo, então ele vai amar este. A diferença não é o jogo, é quem está do outro lado: aqui, só quem você deixou entrar. Mesma diversão, sem o medo.',
      },
      {
        q: 'Seguro de verdade ou só promessa?',
        a: 'Mundo privado e fechado por padrão: ninguém entra sem a sua aprovação. Sem chat com desconhecidos, sem anúncio, sem compra escondida. Você decide quem brinca com seu filho.',
      },
    ] as Qa[],
    guarantee:
      'Quando lançar, são 7 dias grátis sem cartão — e se seu filho não amar, devolvo 100%, sem pergunta nenhuma. O risco é meu, não seu.',
    formTitle: 'Entre na lista e garanta a condição de fundadora',
    formLead:
      'Estamos abrindo as primeiras famílias aos poucos. Deixe seu email (e WhatsApp, se quiser) e você fura a fila — com uma condição especial reservada só pra quem entrar agora.',
    nameLabel: 'Seu nome (opcional)',
    namePlaceholder: 'Como podemos te chamar?',
    emailLabel: 'Seu melhor email',
    emailPlaceholder: 'voce@email.com',
    phoneLabel: 'WhatsApp (opcional)',
    phonePlaceholder: '(11) 90000-0000',
    submit: 'Quero garantir minha vaga',
    submitting: 'Reservando…',
    success:
      'Pronto, sua vaga está reservada! 🎉 Você está na frente da fila. Assim que abrirmos pra sua família, te chamamos primeiro — com a condição de fundadora garantida. Fica de olho no email e no WhatsApp.',
    errorMsg: 'Ops, não consegui salvar agora. Confira o email e tente de novo.',
    faqTitle: 'Perguntas das mães',
    faq: [
      { q: 'Precisa baixar alguma coisa?', a: 'Não. Abre direto no navegador do celular, tablet ou computador. Se quiser, dá pra instalar o atalho na tela inicial em um toque.' },
      { q: 'Meu filho vai falar com estranhos?', a: 'Não. O mundo é privado e fechado — só entram os amigos que você aprovar. Sem chat com gente desconhecida.' },
      { q: 'Quanto vai custar quando lançar?', a: 'Menos que uma pizza por mês para a família toda (até 3-4 crianças), com 7 dias grátis sem cartão pra testar. Quem entra na lista agora trava uma condição especial de fundadora.' },
      { q: 'A partir de que idade dá pra usar?', a: 'Foi feito pra crianças: controles simples e tudo num mundo seguro. Você acompanha e aprova tudo pelo seu celular.' },
    ] as Qa[],
    credit: 'Feito com 🧡 por Dhyego Calota',
  },
  'en-US': {
    badge: '🔒 Pre-launch',
    headline: 'Your kid plays online with friends — and you know exactly who is on the other side.',
    subhead:
      'A Minecraft-style 3D voxel world, multiplayer: no strangers, no toxic chat, no ads and no hidden purchases. Runs in the browser and you control it from your phone.',
    heroCta: 'Save my spot',
    problemTitle: 'Their wish to play should not cost you your peace of mind',
    problem: [
      'You have hesitated before letting your kid into an online game. Not because of the game — because of the stranger on the other side of the screen.',
      'A stranger starting a chat. A chat you do not control. “Buy now” flashing at an 8-year-old.',
    ],
    valueTitle: 'What you get',
    valueStack: [
      { emoji: '🔒', text: 'Private world: only people you approve get in. No strangers, full stop.' },
      { emoji: '💬', text: 'No toxic chat: no messages from people you do not know.' },
      { emoji: '🚫', text: 'No ads and no hidden purchases: zero loot boxes, zero surprise charges.' },
      { emoji: '👀', text: 'You in control: approve the friends and follow it all from your phone.' },
      { emoji: '👫', text: 'Real playing together: cousins and classmates in the same world, live.' },
      { emoji: '🌐', text: 'No download: opens in the browser and installs on phone or tablet in seconds.' },
      { emoji: '🧱', text: 'Fun that builds: create, explore, hunt little monsters and collect stars.' },
    ] as Benefit[],
    objectionsTitle: 'Still unsure?',
    objections: [
      {
        q: 'Roblox is free, why pay?',
        a: 'Free, you pay in worry: strangers, open chat and surprise spending on your card. Here the price of a snack a month buys your peace of mind — with no extra charge to catch you off guard.',
      },
      {
        q: 'My kid already plays another game.',
        a: 'Great, then they will love this one. The difference is not the game, it is who is on the other side: here, only who you let in. Same fun, without the fear.',
      },
      {
        q: 'Truly safe or just a promise?',
        a: 'Private and closed by default: nobody gets in without your approval. No chat with strangers, no ads, no hidden purchases. You decide who plays with your kid.',
      },
    ] as Qa[],
    guarantee:
      'At launch it is 7 days free, no card — and if your kid does not love it, I refund 100%, no questions asked. The risk is mine, not yours.',
    formTitle: 'Join the list and lock the founder deal',
    formLead:
      'We are opening to the first families gradually. Leave your email (and WhatsApp, if you like) to jump the line — with a special deal reserved for whoever joins now.',
    nameLabel: 'Your name (optional)',
    namePlaceholder: 'What should we call you?',
    emailLabel: 'Your best email',
    emailPlaceholder: 'you@email.com',
    phoneLabel: 'WhatsApp (optional)',
    phonePlaceholder: '+1 555 000 0000',
    submit: 'Save my spot',
    submitting: 'Saving…',
    success:
      'Done, your spot is reserved! 🎉 You are at the front of the line. As soon as we open for your family, we call you first — with the founder deal locked in. Keep an eye on your email and WhatsApp.',
    errorMsg: 'Oops, I could not save it just now. Check the email and try again.',
    faqTitle: 'Parents ask',
    faq: [
      { q: 'Do I need to download anything?', a: 'No. It opens right in the browser on phone, tablet or computer. If you want, you can add the shortcut to the home screen in one tap.' },
      { q: 'Will my kid talk to strangers?', a: 'No. The world is private and closed — only the friends you approve get in. No chat with unknown people.' },
      { q: 'How much will it cost at launch?', a: 'Less than a pizza a month for the whole family (up to 3-4 kids), with 7 days free and no card to try it. Joining now locks a special founder deal.' },
      { q: 'What age is it for?', a: 'Built for kids: simple controls and everything inside a safe world. You follow and approve it all from your phone.' },
    ] as Qa[],
    credit: 'Built with 🧡 by Dhyego Calota',
  },
};

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

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (status === 'submitting' || needsToken) return;
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
      <section style={S.hero}>
        <span style={S.badge}>{copy.badge}</span>
        <h1 style={S.brand}>{PLATFORM_NAME}</h1>
        <h2 style={S.headline}>{copy.headline}</h2>
        <p style={S.subhead}>{copy.subhead}</p>
        <a style={S.heroCta} href="#waitlist">{copy.heroCta} →</a>
      </section>

      <section style={S.problem}>
        <h3 style={S.problemTitle}>{copy.problemTitle}</h3>
        {copy.problem.map((line) => (
          <p key={line} style={S.problemLine}>{line}</p>
        ))}
      </section>

      <section style={S.block}>
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

      <section style={S.block}>
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

      <p style={S.guarantee}>🛡️ {copy.guarantee}</p>

      <section id="waitlist" style={S.formSection}>
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
              <button style={S.submit} type="submit" disabled={status === 'submitting' || needsToken}>
                {status === 'submitting' ? copy.submitting : copy.submit}
              </button>
              {status === 'error' && <p style={S.error}>{copy.errorMsg}</p>}
            </form>
          </>
        )}
      </section>

      <section style={S.block}>
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
        <a style={S.email} href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        <a style={S.credit} href="https://dhyegocalota.com.br" target="_blank" rel="noopener noreferrer">
          {copy.credit}
        </a>
      </footer>
    </main>
  );
}

const card: CSSProperties = {
  background: '#ffffffee', borderRadius: 28, padding: '28px 26px', maxWidth: 620, width: '100%',
  boxShadow: '0 24px 60px #0003', border: '6px solid #fff',
};

const S: Record<string, CSSProperties> = {
  wrap: {
    minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22,
    padding: '32px 20px 48px',
    background: 'radial-gradient(circle at 50% 12%, #bfeaff, #7ec8ff 55%, #4aa3e0)',
    fontFamily: "'Baloo 2', 'Comic Sans MS', system-ui, sans-serif", color: '#2a1a4a',
  },
  hero: { ...card, textAlign: 'center', padding: '34px 28px' },
  badge: {
    display: 'inline-block', background: '#2a1a4a', color: '#ffd23f', fontWeight: 800, fontSize: 14,
    padding: '6px 16px', borderRadius: 999, letterSpacing: 0.5,
  },
  brand: { fontSize: 'clamp(40px, 11vw, 76px)', fontWeight: 900, color: '#ff5d2e', textShadow: '0 4px 0 #2a1a4a22', lineHeight: 1, margin: '12px 0 0' },
  headline: { fontSize: 'clamp(22px, 5vw, 34px)', fontWeight: 900, lineHeight: 1.15, margin: '14px 0 0' },
  subhead: { fontSize: 'clamp(15px, 3.4vw, 19px)', fontWeight: 700, color: '#42365a', marginTop: 14, lineHeight: 1.5 },
  heroCta: {
    display: 'inline-block', marginTop: 22, background: 'linear-gradient(#ff8a3d, #ff5d2e)', color: '#fff',
    fontWeight: 900, fontSize: 'clamp(18px, 4.5vw, 22px)', textDecoration: 'none', padding: '16px 38px',
    borderRadius: 20, border: '5px solid #fff', boxShadow: '0 8px 0 #c43d18',
  },
  problem: {
    ...card, background: '#2a1a4af2', border: '6px solid #ffd23f', color: '#fff', textAlign: 'center',
  },
  problemTitle: { fontSize: 'clamp(20px, 4.6vw, 28px)', fontWeight: 900, color: '#ffd23f', margin: 0 },
  problemLine: { fontSize: 'clamp(15px, 3.4vw, 18px)', fontWeight: 700, lineHeight: 1.5, marginTop: 14, color: '#eef0ff' },
  block: { ...card },
  sectionTitle: { fontSize: 'clamp(22px, 5vw, 30px)', fontWeight: 900, textAlign: 'center', margin: '0 0 18px' },
  valueGrid: {
    listStyle: 'none', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
    gap: 12, margin: 0, padding: 0,
  },
  valueCard: { display: 'flex', gap: 12, alignItems: 'flex-start', background: '#f1f6ff', borderRadius: 16, padding: '14px 16px' },
  valueEmoji: { fontSize: 26, lineHeight: 1 },
  valueText: { fontWeight: 800, fontSize: 15, lineHeight: 1.35 },
  objections: { display: 'grid', gap: 12 },
  objectionCard: { background: '#fff7e6', borderRadius: 16, padding: '16px 18px', border: '3px solid #ffe9a8' },
  objectionQ: { fontWeight: 900, fontSize: 17, margin: 0, color: '#ff5d2e' },
  objectionA: { fontWeight: 600, fontSize: 15, lineHeight: 1.5, color: '#42365a', marginTop: 8 },
  guarantee: {
    maxWidth: 620, width: '100%', textAlign: 'center', background: '#ffd23f', borderRadius: 20,
    padding: '18px 22px', fontWeight: 800, fontSize: 'clamp(15px, 3.4vw, 18px)', lineHeight: 1.45,
    border: '5px solid #fff', boxShadow: '0 10px 0 #d9a400',
  },
  formSection: { ...card, textAlign: 'center', border: '6px solid #ff5d2e' },
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
    boxShadow: '0 8px 0 #c43d18', cursor: 'pointer',
  },
  success: { fontSize: 'clamp(16px, 3.6vw, 19px)', fontWeight: 800, lineHeight: 1.5, color: '#2a1a4a', marginTop: 16 },
  error: { fontWeight: 800, color: '#c43d18', fontSize: 15, marginTop: 4 },
  faq: { display: 'grid', gap: 12 },
  faqItem: { background: '#f1f6ff', borderRadius: 16, padding: '14px 16px', textAlign: 'left' },
  faqQ: { fontWeight: 900, fontSize: 16, margin: 0 },
  faqA: { fontWeight: 600, fontSize: 14, lineHeight: 1.5, color: '#42365a', marginTop: 6 },
  footer: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginTop: 6 },
  email: { color: '#1f3a63', fontWeight: 800, textDecoration: 'none', fontSize: 15 },
  credit: { color: '#1f3a63bb', fontWeight: 700, fontSize: 13, textDecoration: 'none' },
};

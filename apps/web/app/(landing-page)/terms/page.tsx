'use client';

// Terms of Use for the parent-facing landing site. Plain-language clauses making the contracting
// parent/guardian responsible for who plays and for how long, and positioning Logic Bit as a
// software provider exempt from liability for in-world interactions. Text only, no form.
import type { CSSProperties } from 'react';
import { currentLocale } from '../../../lib/i18n';
import { PLATFORM_NAME } from '../../../lib/builtins';

const CONTACT_EMAIL = 'legal@logicbit.com.br';
const COMPANY_NAME = 'Logic Bit';
const COMPANY_CNPJ = '32.555.315/0001-91';
const COMPANY_ADDRESS = 'R. Rio Grande do Norte, 1435 — Sala 708, Savassi, Belo Horizonte/MG, CEP 30.130-138';

interface Clause {
  title: string;
  body: string[];
}

const COPY = {
  'pt-BR': {
    back: '← Voltar',
    title: 'Termos de Uso',
    updated: 'Atualizado em julho de 2026',
    intro:
      `Estes Termos de Uso regem o acesso e o uso do ${PLATFORM_NAME}, uma plataforma de mundos 3D ` +
      'de blocos, privados e multiplayer, voltados a crianças. Ao contratar, acessar ou permitir o ' +
      'acesso ao serviço, você concorda com estes Termos. Se não concordar, não utilize a plataforma. ' +
      'Antes de jogar é preciso marcar a caixa de concordância na tela inicial; ao marcá-la e jogar, ' +
      'você confirma que leu e aceita estes Termos e a Política de Privacidade. Crianças só podem jogar ' +
      'com a supervisão de um adulto responsável.',
    clauses: [
      {
        title: '1. O que é o serviço',
        body: [
          `O ${PLATFORM_NAME} fornece a cada responsável contratante um mundo privado e fechado, no ` +
            'qual ele decide quem entra e brinca. O serviço é a plataforma (o software) e as ' +
            'ferramentas de administração que a acompanham.',
          'A plataforma roda no navegador e não exige download. A administração do mundo é feita pelo ' +
            'responsável contratante por meio dos controles fornecidos.',
        ],
      },
      {
        title: '2. Responsabilidade do responsável contratante',
        body: [
          'O responsável (pai, mãe ou guardião) que contrata o serviço é o único responsável por ' +
            'aprovar e autorizar quem joga no seu mundo, acompanhar os participantes e o que acontece ' +
            'dentro do jogo, definir e fazer cumprir limites de tempo de uso e supervisionar o uso ' +
            'pelas crianças sob sua guarda.',
          'A plataforma oferece os controles para isso — aprovação de administrador e moderador, ' +
            'limites de tempo de jogo, suspensão, expulsão e banimento. Cabe ao responsável usá-los. ' +
            'Você é responsável pelas pessoas que convida e aprova no seu mundo.',
        ],
      },
      {
        title: '3. Uso por menores',
        body: [
          'O serviço é destinado a crianças, sempre sob a responsabilidade e a supervisão de um ' +
            'adulto responsável. O cadastro, a contratação e a gestão do mundo são feitos por esse ' +
            'adulto, que responde pelo uso por parte dos menores sob sua guarda.',
        ],
      },
      {
        title: '4. Uso aceitável',
        body: [
          'Você concorda em não usar o serviço para fins ilegais, abusivos ou que prejudiquem outras ' +
            'pessoas, e em não tentar burlar, sobrecarregar ou comprometer a plataforma.',
          'O responsável deve manter um ambiente saudável no seu mundo, agindo sobre condutas ' +
            'inadequadas com as ferramentas de moderação disponíveis.',
        ],
      },
      {
        title: '5. Suspensão e encerramento',
        body: [
          `A ${COMPANY_NAME} pode suspender ou encerrar o acesso, no todo ou em parte, em caso de ` +
            'abuso, uso indevido ou violação destes Termos.',
          'Dentro de cada mundo, o responsável contratante pode suspender, expulsar e banir ' +
            'participantes a seu critério, usando os controles da plataforma.',
        ],
      },
      {
        title: '6. Isenção de responsabilidade',
        body: [
          `A ${COMPANY_NAME} é apenas a fornecedora do software e fica isenta de responsabilidade por ` +
            'interações, conteúdos, condutas ou qualquer fato ocorrido entre participantes dentro de ' +
            'um mundo. A plataforma entrega as ferramentas; o dever de acompanhar e de decidir quem ' +
            'joga e por quanto tempo é do responsável contratante.',
          'O serviço é fornecido "no estado em que se encontra", sem garantias de disponibilidade ' +
            'ininterrupta ou ausência de falhas. Não prometemos certificações ou resultados que não ' +
            'possamos honrar.',
          'Na máxima medida permitida pela lei aplicável, a responsabilidade da ' +
            `${COMPANY_NAME} fica limitada aos valores efetivamente pagos pelo serviço no período em ` +
            'que o fato ocorreu.',
        ],
      },
      {
        title: '7. Lei aplicável',
        body: [
          'Estes Termos são regidos pelas leis da República Federativa do Brasil, incluindo a Lei ' +
            'Geral de Proteção de Dados (LGPD). Eventuais conflitos serão resolvidos no foro do ' +
            'domicílio do responsável contratante.',
        ],
      },
      {
        title: '8. Contato',
        body: [`Dúvidas sobre estes Termos podem ser enviadas para ${CONTACT_EMAIL}.`],
      },
    ] as Clause[],
  },
  'en-US': {
    back: '← Back',
    title: 'Terms of Use',
    updated: 'Updated July 2026',
    intro:
      `These Terms of Use govern access to and use of ${PLATFORM_NAME}, a platform of private, ` +
      'multiplayer 3D voxel worlds made for kids. By contracting, accessing or allowing access to the ' +
      'service, you agree to these Terms. If you do not agree, do not use the platform. Before playing ' +
      'you must tick the agreement box on the start screen; by ticking it and playing, you confirm you ' +
      'have read and accept these Terms and the Privacy Policy. Children may only play with the ' +
      'supervision of a responsible adult.',
    clauses: [
      {
        title: '1. What the service is',
        body: [
          `${PLATFORM_NAME} gives each contracting parent or guardian a private, closed world where ` +
            'they decide who gets in and plays. The service is the platform (the software) and the ' +
            'administration tools that come with it.',
          'The platform runs in the browser and requires no download. The world is administered by ' +
            'the contracting parent through the controls provided.',
        ],
      },
      {
        title: '2. Responsibility of the contracting parent',
        body: [
          'The parent or guardian who contracts the service is solely responsible for approving and ' +
            'authorizing who plays in their world, monitoring the players and what happens in-game, ' +
            'setting and enforcing play-time limits, and supervising use by the children in their care.',
          'The platform provides the controls for this — admin and moderator approval, play-time ' +
            'limits, suspend, kick and ban. It is up to the parent to use them. You are responsible ' +
            'for the people you invite and approve into your world.',
        ],
      },
      {
        title: '3. Use by minors',
        body: [
          'The service is intended for children, always under the responsibility and supervision of a ' +
            'responsible adult. Sign-up, contracting and world management are done by that adult, who ' +
            'is accountable for use by the minors in their care.',
        ],
      },
      {
        title: '4. Acceptable use',
        body: [
          'You agree not to use the service for unlawful or abusive purposes or in ways that harm ' +
            'others, and not to attempt to bypass, overload or compromise the platform.',
          'The parent must keep a healthy environment in their world, acting on inappropriate conduct ' +
            'with the moderation tools available.',
        ],
      },
      {
        title: '5. Suspension and termination',
        body: [
          `${COMPANY_NAME} may suspend or terminate access, in whole or in part, in case of abuse, ` +
            'misuse or breach of these Terms.',
          'Within each world, the contracting parent may suspend, kick and ban participants at their ' +
            'discretion, using the platform controls.',
        ],
      },
      {
        title: '6. Limitation of liability',
        body: [
          `${COMPANY_NAME} is solely the software provider and is exempt from liability for ` +
            'interactions, content, conduct or anything that happens between participants inside a ' +
            'world. The platform delivers the tools; the duty to monitor and to decide who plays and ' +
            'for how long lies with the contracting parent.',
          'The service is provided "as is", with no guarantee of uninterrupted availability or ' +
            'freedom from faults. We do not promise certifications or results we cannot honor.',
          `To the maximum extent permitted by applicable law, ${COMPANY_NAME}'s liability is limited ` +
            'to the amounts actually paid for the service in the period in which the event occurred.',
        ],
      },
      {
        title: '7. Governing law',
        body: [
          'These Terms are governed by the laws of the Federative Republic of Brazil, including the ' +
            'General Data Protection Law (LGPD). Any disputes will be resolved in the courts of the ' +
            'contracting parent’s domicile.',
        ],
      },
      {
        title: '8. Contact',
        body: [`Questions about these Terms can be sent to ${CONTACT_EMAIL}.`],
      },
    ] as Clause[],
  },
};

export default function Terms() {
  const copy = COPY[currentLocale()];

  return (
    <main style={S.wrap}>
      <a style={S.back} href="/">{copy.back}</a>
      <article style={S.card}>
        <h1 style={S.brand}>{PLATFORM_NAME}</h1>
        <h2 style={S.title}>{copy.title}</h2>
        <p style={S.updated}>{copy.updated}</p>
        <p style={S.intro}>{copy.intro}</p>
        {copy.clauses.map((clause) => (
          <section key={clause.title} style={S.clause}>
            <h3 style={S.clauseTitle}>{clause.title}</h3>
            {clause.body.map((line) => (
              <p key={line} style={S.clauseLine}>{line}</p>
            ))}
          </section>
        ))}
      </article>

      <footer style={S.footer}>
        <p style={S.company}>{COMPANY_NAME} — CNPJ {COMPANY_CNPJ}</p>
        <p style={S.company}>{COMPANY_ADDRESS}</p>
        <a style={S.email} href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </footer>
    </main>
  );
}

const card: CSSProperties = {
  background: '#ffffffee', borderRadius: 28, padding: '28px 26px', maxWidth: 680, width: '100%',
  boxShadow: '0 24px 60px #0003', border: '6px solid #fff',
};

const S: Record<string, CSSProperties> = {
  wrap: {
    minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22,
    padding: '32px 20px 48px',
    background: 'radial-gradient(circle at 50% 12%, #bfeaff, #7ec8ff 55%, #4aa3e0)',
    fontFamily: "'Comic Sans MS', system-ui, sans-serif", color: '#2a1a4a',
  },
  back: {
    alignSelf: 'flex-start', maxWidth: 680, width: '100%', color: '#1f3a63', fontWeight: 800,
    fontSize: 15, textDecoration: 'none',
  },
  card: { ...card },
  brand: { fontSize: 'clamp(34px, 9vw, 60px)', fontWeight: 900, color: '#ff5d2e', textShadow: '0 4px 0 #2a1a4a22', lineHeight: 1, margin: 0, textAlign: 'center' },
  title: { fontSize: 'clamp(22px, 5vw, 32px)', fontWeight: 900, textAlign: 'center', margin: '12px 0 0' },
  updated: { fontSize: 13, fontWeight: 700, color: '#42365a', textAlign: 'center', marginTop: 6 },
  intro: { fontSize: 'clamp(15px, 3.2vw, 17px)', fontWeight: 700, color: '#42365a', lineHeight: 1.55, marginTop: 18 },
  clause: { marginTop: 22 },
  clauseTitle: { fontSize: 'clamp(18px, 4vw, 22px)', fontWeight: 900, color: '#ff5d2e', margin: 0 },
  clauseLine: { fontSize: 15, fontWeight: 600, color: '#42365a', lineHeight: 1.6, marginTop: 10 },
  footer: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, marginTop: 6, textAlign: 'center', maxWidth: 680 },
  company: { color: '#1f3a63', fontWeight: 700, fontSize: 13, margin: 0, lineHeight: 1.5 },
  email: { color: '#1f3a63', fontWeight: 800, textDecoration: 'none', fontSize: 14 },
};

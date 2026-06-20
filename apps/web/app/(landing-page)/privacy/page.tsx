'use client';

// Privacy Policy for the parent-facing landing site. Describes truthfully what the app collects
// (waitlist, magic-link accounts, gameplay data, basic logs), why, the LGPD rights and the data
// controller (Logic Bit). Text only, no form.
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
    title: 'Política de Privacidade',
    updated: 'Atualizado em junho de 2026',
    intro:
      `Esta Política descreve como o ${PLATFORM_NAME} trata dados pessoais, em conformidade com a Lei ` +
      'Geral de Proteção de Dados (LGPD). Tratamos apenas os dados necessários para operar o serviço.',
    clauses: [
      {
        title: '1. Controlador dos dados',
        body: [
          `O controlador é a ${COMPANY_NAME}, CNPJ ${COMPANY_CNPJ}, com sede em ${COMPANY_ADDRESS}. ` +
            `Contato para assuntos de privacidade: ${CONTACT_EMAIL}.`,
        ],
      },
      {
        title: '2. Dados que coletamos',
        body: [
          'Lista de espera (pré-lançamento): email e, opcionalmente, nome e WhatsApp informados por ' +
            'você no formulário.',
          'Contas de acesso: nome de usuário e email, usados no login por link mágico (magic link).',
          'Dados de jogo: pontuações, posições, edições do mundo e ações realizadas durante o uso.',
          'Registros básicos (logs): dados técnicos como endereço IP e horário, necessários para ' +
            'segurança e funcionamento do serviço.',
        ],
      },
      {
        title: '3. Para que usamos',
        body: [
          'Operar o serviço e os mundos, autenticar o acesso pelo link mágico, montar os rankings ' +
            '(leaderboards) e entrar em contato sobre o lançamento e novidades.',
          'Não vendemos dados pessoais a terceiros.',
        ],
      },
      {
        title: '4. Como funciona o login',
        body: [
          'O acesso é feito por link mágico enviado por email. O envio dos emails é operado pelo ' +
            'provedor de email transacional (Resend). Os dados de contas e de jogo ficam armazenados ' +
            'em banco de dados por tenant (libSQL).',
        ],
      },
      {
        title: '5. Análise e monitoramento de erros',
        body: [
          'Usamos análise de uso básica (Vercel Analytics) e monitoramento de erros (Sentry) para ' +
            'entender o uso agregado e corrigir falhas. Não utilizamos esses dados para vender ou ' +
            'perfilar pessoas, e não há outros rastreadores além desses.',
        ],
      },
      {
        title: '6. Dados de crianças',
        body: [
          'Os dados de crianças são fornecidos e geridos sob a responsabilidade do adulto responsável ' +
            'que contrata e administra o mundo. Esse responsável decide quem participa e supervisiona ' +
            'o uso, conforme os Termos de Uso.',
        ],
      },
      {
        title: '7. Seus direitos (LGPD)',
        body: [
          'Você pode solicitar acesso, correção e exclusão dos seus dados, bem como informações sobre ' +
            `o tratamento, escrevendo para ${CONTACT_EMAIL}.`,
          'O tratamento se baseia, conforme o caso, no consentimento, na execução do contrato de ' +
            'prestação do serviço e no legítimo interesse para segurança e melhoria da plataforma.',
        ],
      },
      {
        title: '8. Retenção',
        body: [
          'Mantemos os dados pelo tempo necessário às finalidades acima e às obrigações legais. ' +
            'Quando deixam de ser necessários ou quando você solicita a exclusão, os dados são ' +
            'eliminados.',
        ],
      },
      {
        title: '9. Contato',
        body: [`Dúvidas e solicitações sobre esta Política podem ser enviadas para ${CONTACT_EMAIL}.`],
      },
    ] as Clause[],
  },
  'en-US': {
    back: '← Back',
    title: 'Privacy Policy',
    updated: 'Updated June 2026',
    intro:
      `This Policy describes how ${PLATFORM_NAME} handles personal data, in line with the Brazilian ` +
      'General Data Protection Law (LGPD). We process only the data needed to run the service.',
    clauses: [
      {
        title: '1. Data controller',
        body: [
          `The controller is ${COMPANY_NAME}, CNPJ ${COMPANY_CNPJ}, located at ${COMPANY_ADDRESS}. ` +
            `Contact for privacy matters: ${CONTACT_EMAIL}.`,
        ],
      },
      {
        title: '2. Data we collect',
        body: [
          'Waitlist (pre-launch): email and, optionally, the name and WhatsApp you enter in the form.',
          'Accounts: username and email, used for the magic-link login.',
          'Gameplay data: scores, positions, world edits and actions taken during use.',
          'Basic logs: technical data such as IP address and timestamp, needed for security and for ' +
            'the service to work.',
        ],
      },
      {
        title: '3. What we use it for',
        body: [
          'To run the service and the worlds, authenticate access via the magic link, build the ' +
            'leaderboards, and contact you about the launch and news.',
          'We do not sell personal data to third parties.',
        ],
      },
      {
        title: '4. How login works',
        body: [
          'Access is done through a magic link sent by email. Email delivery is operated by the ' +
            'transactional email provider (Resend). Account and gameplay data are stored in a ' +
            'per-tenant database (libSQL).',
        ],
      },
      {
        title: '5. Analytics and error monitoring',
        body: [
          'We use basic usage analytics (Vercel Analytics) and error monitoring (Sentry) to ' +
            'understand aggregate usage and fix faults. We do not use this data to sell or profile ' +
            'people, and there are no other trackers beyond these.',
        ],
      },
      {
        title: '6. Children’s data',
        body: [
          'Children’s data is provided and managed under the responsibility of the responsible adult ' +
            'who contracts and administers the world. That adult decides who takes part and ' +
            'supervises use, as set out in the Terms of Use.',
        ],
      },
      {
        title: '7. Your rights (LGPD)',
        body: [
          'You may request access, correction and deletion of your data, as well as information about ' +
            `the processing, by writing to ${CONTACT_EMAIL}.`,
          'Processing is based, as applicable, on consent, on performance of the service contract, ' +
            'and on legitimate interest for the security and improvement of the platform.',
        ],
      },
      {
        title: '8. Retention',
        body: [
          'We keep data for as long as needed for the purposes above and for legal obligations. When ' +
            'no longer needed, or when you request deletion, the data is erased.',
        ],
      },
      {
        title: '9. Contact',
        body: [`Questions and requests about this Policy can be sent to ${CONTACT_EMAIL}.`],
      },
    ] as Clause[],
  },
};

export default function Privacy() {
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
    fontFamily: "'Baloo 2', 'Comic Sans MS', system-ui, sans-serif", color: '#2a1a4a',
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

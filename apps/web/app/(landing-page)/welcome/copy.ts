// Localized copy and the pure form-gating helper for the waitlist landing page. Kept out of
// page.tsx because Next.js only allows the default component and reserved fields to be exported
// from a page module.
import { localePrefix, type Locale } from '../../../lib/i18n/locale';

// The demo runs on its own subdomain; carry the current locale in the URL so it opens in the same
// language the parent is reading (the locale cookie is host-only and won't cross the subdomain).
export const DEMO_URL = 'https://demo.blockland.dhyegocalota.com.br';

export function demoUrl(locale: Locale): string {
  return `${DEMO_URL}/${localePrefix(locale)}`;
}

interface Benefit {
  emoji: string;
  text: string;
}

interface Qa {
  q: string;
  a: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailValid(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

export const COPY = {
  'pt-BR': {
    badge: '🔒 Pré-lançamento',
    headline: 'Seu filho brinca online com os amigos — e você sabe exatamente quem está do outro lado.',
    subhead:
      'Mundo de blocos 3D, multiplayer: sem estranhos, sem chat tóxico, sem anúncio e sem compra escondida. Abre no navegador e você controla pelo seu celular.',
    heroCta: 'Quero garantir minha vaga',
    demoCta: '🎮 Jogar a demo grátis (5 min)',
    demoNote: 'Sem cadastro. Abre no navegador e você sente o jogo na hora.',
    problemTitle: 'A vontade dele de brincar não devia custar o seu sossego',
    problem: [
      'Você já travou na hora de deixar seu filho entrar num jogo online. Não pelo jogo — pelo desconhecido do outro lado da tela.',
      'Estranho puxando assunto. Chat que você não controla. “Compre agora” piscando pra uma criança de 8 anos.',
    ],
    valueTitle: 'O que você ganha',
    valueStack: [
      { emoji: '🔒', text: 'Você controla quem entra: pode exigir sua aprovação pra cada novo jogador, e expulsar ou banir na hora.' },
      { emoji: '💬', text: 'Sem chat tóxico: nada de mensagem de gente que você não conhece.' },
      { emoji: '🚫', text: 'Sem anúncio e sem compra escondida: zero loot box, zero susto na fatura.' },
      { emoji: '👀', text: 'Você no controle: aprova jogadores, expulsa, bane e acompanha tudo pelo seu celular.' },
      { emoji: '👫', text: 'Até 10 amigos no mesmo mundo, ao vivo: primos e colegas brincando juntos de verdade.' },
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
        a: 'Mundo privado e seu: você decide quem brinca. Pode exigir sua aprovação pra cada novo jogador e expulsar ou banir na hora — além de zero chat com desconhecidos, zero anúncio e zero compra escondida.',
      },
    ] as Qa[],
    guarantee:
      'Quando lançar, são 7 dias grátis sem cartão — e se seu filho não amar, devolvo 100%, sem pergunta nenhuma. O risco é meu, não seu.',
    formTitle: 'Entre na lista e garanta a condição de membro fundador',
    formLead:
      'Estamos abrindo as primeiras famílias aos poucos. Deixe seu email (e WhatsApp, se quiser) e você fura a fila — com uma condição especial reservada só pra quem entrar agora.',
    nameLabel: 'Seu nome (opcional)',
    namePlaceholder: 'Como podemos te chamar?',
    emailLabel: 'Seu melhor email',
    emailPlaceholder: 'voce@email.com',
    phoneLabel: 'WhatsApp (opcional)',
    phonePlaceholder: '(11) 90000-0000',
    consentLabel: 'Sou o adulto responsável, concordo com a Política de Privacidade e os Termos de Uso, e assumo integralmente a responsabilidade de supervisionar, em todos os momentos, o uso e os dados da(s) criança(s) sob minha responsabilidade.',
    submit: 'Entrar na lista',
    submitting: 'Entrando…',
    success:
      'Pronto, sua vaga está reservada! 🎉 Você está na frente da fila. Assim que abrirmos pra sua família, te chamamos primeiro — com a condição de membro fundador garantida. Fica de olho no email e no WhatsApp.',
    errorMsg: 'Ops, não consegui salvar agora. Confira o email e tente de novo.',
    faqTitle: 'Perguntas dos pais',
    faq: [
      { q: 'Precisa baixar alguma coisa?', a: 'Não. Abre direto no navegador do celular, tablet ou computador. Se quiser, dá pra instalar o atalho na tela inicial em um toque.' },
      { q: 'Meu filho vai falar com estranhos?', a: 'O mundo é privado e seu. Você pode exigir aprovação pra cada novo jogador e expulsar ou banir quando quiser — e não existe chat com gente desconhecida.' },
      { q: 'Quanto vai custar quando lançar?', a: 'Menos que uma pizza por mês para a família toda (até 3-4 crianças), com 7 dias grátis sem cartão pra testar. Quem entra na lista agora trava uma condição especial de membro fundador.' },
      { q: 'A partir de que idade dá pra usar?', a: 'Foi feito pra crianças: controles simples e tudo num mundo seguro. Você acompanha e aprova tudo pelo seu celular.' },
    ] as Qa[],
    founderTitle: 'Quem está por trás disso',
    founderStory: [
      'Oi, eu sou o Dhyego. Sou desenvolvedor — e, antes de tudo, marido e pai.',
      'Esse joguinho nasceu de uma vontade simples: deixar meu filho construir, explorar e brincar online com os amigos sem que eu ficasse com o coração na mão. Procurei um lugar assim e não encontrei. Então resolvi construir um — do jeito que eu, como pai, gostaria de achar.',
      'Cada detalhe aqui passou por uma pergunta: "eu deixaria meu filho nesse mundo?". Quando a resposta era não, não entrava.',
    ],
    founderSign: '— Dhyego Calota, pai e criador do Blockland',
    terms: 'Termos de Uso',
    privacy: 'Política de Privacidade',
    cookies: '🍪 Cookies',
    disclaimer: 'Blockland é um produto independente, sem afiliação, associação ou endosso da Mojang Synergies AB ou da Microsoft. Minecraft é marca registrada da Mojang.',
    companyLine: 'Logic Bit · CNPJ 32.555.315/0001-91',
    addressLine: 'R. Rio Grande do Norte, 1435 — Sala 708, Savassi, Belo Horizonte/MG',
    credit: 'Feito com 🧡 por Dhyego Calota',
  },
  'en-US': {
    badge: '🔒 Pre-launch',
    headline: 'Your kid plays online with friends — and you know exactly who is on the other side.',
    subhead:
      'A 3D voxel block-building world, multiplayer: no strangers, no toxic chat, no ads and no hidden purchases. Runs in the browser and you control it from your phone.',
    heroCta: 'Save my spot',
    demoCta: '🎮 Play the free demo (5 min)',
    demoNote: 'No signup. Opens in the browser and you feel the game right away.',
    problemTitle: 'Their wish to play should not cost you your peace of mind',
    problem: [
      'You have hesitated before letting your kid into an online game. Not because of the game — because of the stranger on the other side of the screen.',
      'A stranger starting a chat. A chat you do not control. “Buy now” flashing at an 8-year-old.',
    ],
    valueTitle: 'What you get',
    valueStack: [
      { emoji: '🔒', text: 'You control who joins: you can require your approval for each new player, and kick or ban anytime.' },
      { emoji: '💬', text: 'No toxic chat: no messages from people you do not know.' },
      { emoji: '🚫', text: 'No ads and no hidden purchases: zero loot boxes, zero surprise charges.' },
      { emoji: '👀', text: 'You in control: approve the friends and follow it all from your phone.' },
      { emoji: '👫', text: 'Up to 10 friends in the same world, live: cousins and classmates really playing together.' },
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
        a: 'Your own private world: you decide who plays. You can require your approval for every new player and kick or ban anytime — plus no chat with strangers, no ads, no hidden purchases.',
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
    consentLabel: 'I am the responsible adult, I agree to the Privacy Policy and Terms of Use, and I take full responsibility for supervising, at all times, the use and the data of the child(ren) under my care.',
    submit: 'Join the list',
    submitting: 'Joining…',
    success:
      'Done, your spot is reserved! 🎉 You are at the front of the line. As soon as we open for your family, we call you first — with the founder deal locked in. Keep an eye on your email and WhatsApp.',
    errorMsg: 'Oops, I could not save it just now. Check the email and try again.',
    faqTitle: 'Parents ask',
    faq: [
      { q: 'Do I need to download anything?', a: 'No. It opens right in the browser on phone, tablet or computer. If you want, you can add the shortcut to the home screen in one tap.' },
      { q: 'Will my kid talk to strangers?', a: 'The world is private and yours. You can require approval for each new player and kick or ban anytime — and there is no chat with unknown people.' },
      { q: 'How much will it cost at launch?', a: 'Less than a pizza a month for the whole family (up to 3-4 kids), with 7 days free and no card to try it. Joining now locks a special founder deal.' },
      { q: 'What age is it for?', a: 'Built for kids: simple controls and everything inside a safe world. You follow and approve it all from your phone.' },
    ] as Qa[],
    founderTitle: 'Who is behind this',
    founderStory: [
      'Hi, I am Dhyego. I am a developer — and, above all, a husband and a dad.',
      'This little game came from a simple wish: to let my son build, explore and play online with his friends without me holding my breath the whole time. I looked for a place like that and could not find one. So I built it — the way I, as a dad, would want to find it.',
      'Every detail here went through one question: "would I let my own kid into this world?" When the answer was no, it did not make it in.',
    ],
    founderSign: '— Dhyego Calota, dad and creator of Blockland',
    terms: 'Terms of Use',
    privacy: 'Privacy Policy',
    cookies: '🍪 Cookies',
    disclaimer: 'Blockland is an independent product, not affiliated with, associated with, or endorsed by Mojang Synergies AB or Microsoft. Minecraft is a trademark of Mojang.',
    companyLine: 'Logic Bit · CNPJ 32.555.315/0001-91',
    addressLine: 'R. Rio Grande do Norte, 1435 — Sala 708, Savassi, Belo Horizonte/MG',
    credit: 'Built with 🧡 by Dhyego Calota',
  },
};

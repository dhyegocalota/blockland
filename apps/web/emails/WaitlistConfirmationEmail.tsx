// Waitlist confirmation sent to the parent (pt-BR, the offer's audience): their spot is reserved and
// the founder deal is locked in. Rendered by lib/mailer.ts via @react-email/render.
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Text,
} from '@react-email/components';

export interface WaitlistConfirmationEmailProps {
  name: string | null;
}

const main = { backgroundColor: '#1a1030', fontFamily: 'system-ui, sans-serif', padding: '24px' };
const container = { backgroundColor: '#ffffff', borderRadius: '16px', padding: '32px', maxWidth: '460px' };
const heading = { color: '#1a1030', fontSize: '22px', fontWeight: 700 as const, margin: '0 0 12px' };
const text = { color: '#3a2a4a', fontSize: '15px', lineHeight: '1.6', margin: '0 0 16px' };
const accent = { color: '#ff5d2e', fontWeight: 700 as const };

export function WaitlistConfirmationEmail({ name }: WaitlistConfirmationEmailProps) {
  const greeting = name ? `Oi, ${name}! 🎉` : 'Oi! 🎉';
  return (
    <Html>
      <Head />
      <Preview>Sua vaga no Blockland está reservada</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={heading}>{greeting}</Heading>
          <Text style={text}>
            Sua vaga está reservada e você está <span style={accent}>na frente da fila</span>. Assim que
            abrirmos para a sua família, te chamamos primeiro.
          </Text>
          <Text style={text}>
            Você garantiu a <span style={accent}>condição de fundadora</span>: 7 dias grátis sem cartão
            e um preço especial só para quem entrou agora, antes do lançamento.
          </Text>
          <Text style={text}>Fica de olho no email e no WhatsApp. 🧡</Text>
        </Container>
      </Body>
    </Html>
  );
}

export default WaitlistConfirmationEmail;

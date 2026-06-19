// Magic-link login email: a friendly greeting, the 6-digit code shown big, and a "log in" button
// that opens the claim page with the token. Rendered by lib/mailer.ts via @react-email/render.
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components';

export interface MagicLinkEmailProps {
  name: string;
  code: string;
  magicLink: string;
}

const main = { backgroundColor: '#1a1030', fontFamily: 'system-ui, sans-serif', padding: '24px' };
const container = { backgroundColor: '#ffffff', borderRadius: '16px', padding: '32px', maxWidth: '420px' };
const heading = { color: '#1a1030', fontSize: '22px', fontWeight: 700 as const, margin: '0 0 12px' };
const text = { color: '#3a2a4a', fontSize: '15px', lineHeight: '1.5', margin: '0 0 16px' };
const codeBox = {
  color: '#ff5d2e',
  fontSize: '40px',
  fontWeight: 800 as const,
  letterSpacing: '8px',
  textAlign: 'center' as const,
  margin: '8px 0 24px',
};
const button = {
  backgroundColor: '#ff5d2e',
  borderRadius: '12px',
  color: '#ffffff',
  display: 'block',
  fontSize: '16px',
  fontWeight: 700 as const,
  padding: '14px 20px',
  textAlign: 'center' as const,
  textDecoration: 'none',
};

export function MagicLinkEmail({ name, code, magicLink }: MagicLinkEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>{`Your login code is ${code}`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={heading}>{`Hi, ${name}! 👋`}</Heading>
          <Text style={text}>Use this code to log in, or tap the button below.</Text>
          <Text style={codeBox}>{code}</Text>
          <Section>
            <Button href={magicLink} style={button}>
              Log in
            </Button>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default MagicLinkEmail;

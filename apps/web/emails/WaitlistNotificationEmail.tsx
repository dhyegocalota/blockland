// Internal notice sent to the admin (en-US) when a parent joins the waitlist, with the captured
// contact details. Rendered by lib/mailer.ts via @react-email/render.
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Text,
} from '@react-email/components';

export interface WaitlistNotificationEmailProps {
  email: string;
  name: string | null;
  phone: string | null;
}

const main = { backgroundColor: '#1a1030', fontFamily: 'system-ui, sans-serif', padding: '24px' };
const container = { backgroundColor: '#ffffff', borderRadius: '16px', padding: '32px', maxWidth: '460px' };
const heading = { color: '#1a1030', fontSize: '20px', fontWeight: 700 as const, margin: '0 0 16px' };
const row = { color: '#3a2a4a', fontSize: '15px', lineHeight: '1.5', margin: '0 0 8px' };
const label = { color: '#8a7aa0', fontWeight: 700 as const };

export function WaitlistNotificationEmail({ email, name, phone }: WaitlistNotificationEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>{`New waitlist signup: ${email}`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={heading}>New waitlist signup 🎯</Heading>
          <Text style={row}>
            <span style={label}>Email: </span>
            {email}
          </Text>
          {name && (
            <Text style={row}>
              <span style={label}>Name: </span>
              {name}
            </Text>
          )}
          {phone && (
            <Text style={row}>
              <span style={label}>WhatsApp: </span>
              {phone}
            </Text>
          )}
        </Container>
      </Body>
    </Html>
  );
}

export default WaitlistNotificationEmail;

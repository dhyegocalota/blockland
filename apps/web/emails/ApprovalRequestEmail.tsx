// Internal notice sent to a tenant's admins (en-US) when a new player is held out by the approval
// gate and is waiting to be let in. Rendered by lib/mailer.ts via @react-email/render.
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Text,
} from '@react-email/components';

export interface ApprovalRequestEmailProps {
  name: string;
  tenant: string;
}

const main = { backgroundColor: '#1a1030', fontFamily: 'system-ui, sans-serif', padding: '24px' };
const container = { backgroundColor: '#ffffff', borderRadius: '16px', padding: '32px', maxWidth: '460px' };
const heading = { color: '#1a1030', fontSize: '20px', fontWeight: 700 as const, margin: '0 0 16px' };
const row = { color: '#3a2a4a', fontSize: '15px', lineHeight: '1.5', margin: '0 0 8px' };
const label = { color: '#8a7aa0', fontWeight: 700 as const };

export function ApprovalRequestEmail({ name, tenant }: ApprovalRequestEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>{`${name} is waiting to join`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={heading}>A new player is waiting 🙋</Heading>
          <Text style={row}>
            <span style={label}>Player: </span>
            {name}
          </Text>
          <Text style={row}>
            <span style={label}>World: </span>
            {tenant}
          </Text>
          <Text style={row}>Open the world and approve them from the admin panel to let them in.</Text>
        </Container>
      </Body>
    </Html>
  );
}

export default ApprovalRequestEmail;

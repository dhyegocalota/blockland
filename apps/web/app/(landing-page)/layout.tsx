import type { CSSProperties, ReactNode } from 'react';
import LocaleSwitcher from '../../components/LocaleSwitcher';

const SWITCHER_WRAP: CSSProperties = {
  position: 'fixed',
  top: 14,
  right: 14,
  zIndex: 50,
};

export default function LandingLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <div style={SWITCHER_WRAP}>
        <LocaleSwitcher />
      </div>
      {children}
    </>
  );
}

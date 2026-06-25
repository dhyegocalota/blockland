'use client';

// Shared Cloudflare Turnstile widget — used by the waitlist form and the in-game email login to stop
// abuse (e.g. spamming the magic-code email). Renders explicitly once the script is ready and hands the
// verified token up so the caller can submit it. Only mount it when a site key is configured
// (NEXT_PUBLIC_TURNSTILE_SITE_KEY); the server then re-verifies the token with `verifyTurnstile`.
import { useEffect, useRef, type CSSProperties } from 'react';
import Script from 'next/script';

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

export default function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (token: string) => void }) {
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
      <div ref={box} style={WIDGET_STYLE} />
    </>
  );
}

const WIDGET_STYLE: CSSProperties = { display: 'flex', justifyContent: 'center', minHeight: 65 };

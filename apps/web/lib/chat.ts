// Transient in-game chat overlay lines. Lines are capped to the most recent few and each fades out
// after a short delay; this module owns the pure list math, the hook (use-chat) owns the timers.
export const CHAT_BACKLOG = 6;
export const CHAT_FADE_MS = 8000;

export interface ChatLine {
  id: number;
  name: string;
  text: string;
}

export function appendChatLine(args: { lines: ChatLine[]; line: ChatLine; cap: number }): ChatLine[] {
  return [...args.lines, args.line].slice(-args.cap);
}

export function dropChatLine(args: { lines: ChatLine[]; id: number }): ChatLine[] {
  return args.lines.filter((line) => line.id !== args.id);
}

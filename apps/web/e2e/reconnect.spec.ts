import { test, expect, type BrowserContext, type Page } from '@playwright/test';

// End-to-end proof that an internet drop → auto-reconnect is a COHERENT visual experience for both the
// dropped player and the others. Requires the full stack up (authoritative Rust server + this Next app
// pointed at it via NEXT_PUBLIC_SERVER_URL) — see e2e/README.md for booting it. Two browser contexts
// stand in for two players in the same world.
//
// What it asserts:
//  - A and B each see the other (the presence roster lists both).
//  - Dropping A (context.setOffline(true)) shows A a friendly RECONNECTING overlay (not a terminal
//    error), and B STILL sees A's avatar during the server grace — no instant "left".
//  - Restoring A (context.setOffline(false)) returns A to online (the overlay clears) and B keeps seeing
//    A resumed — no permanent leave.

// Start the engine as an anonymous guest in online (multiplayer) mode, then wait until the world is live
// (the presence toggle reflects the online count). Multiplayer is the default mode, so we only ensure it
// is selected, leave the name empty (guest), and press Play.
async function joinAsGuest(page: Page): Promise<void> {
  await page.goto('/');
  // Multiplayer is the default mode; select it if a mode toggle is shown.
  const multiplayer = page.getByRole('button', { name: /multiplayer|multijogador/i });
  if (await multiplayer.isVisible().catch(() => false)) await multiplayer.click({ force: true }).catch(() => {});
  // The lobby runs idle animations (drifting clouds, a bobbing avatar) and the leaderboard polls +
  // re-renders, so the Play button is never "stable" by Playwright's heuristic. Dispatch the click event
  // directly (React's delegated onClick still fires) instead of waiting for an impossible settle.
  const play = page.locator('#playBtn');
  await expect(play).toBeVisible({ timeout: 20_000 });
  await play.dispatchEvent('click');
  // The connecting overlay is up until Welcome + first snapshot land; it clears once the world is live.
  await expect(page.locator('#connectingOverlay')).toBeHidden({ timeout: 25_000 });
  await expect(page.locator('#presenceToggle')).toBeVisible();
}

// The count of players the presence list shows (open it first; it is collapsed by default).
async function rosterNames(page: Page): Promise<string[]> {
  await page.locator('#presenceToggle').click();
  const items = await page.locator('#presenceList li').allTextContents();
  await page.locator('#presenceToggle').click();
  return items;
}

test('a dropped player reconnects coherently for themselves and for others', async ({ browser }) => {
  const contextA: BrowserContext = await browser.newContext();
  const contextB: BrowserContext = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await joinAsGuest(pageA);
  await joinAsGuest(pageB);

  // Both players see each other: the presence roster lists two people on each side.
  await expect(async () => {
    expect((await rosterNames(pageA)).length).toBeGreaterThanOrEqual(2);
    expect((await rosterNames(pageB)).length).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 15_000 });

  // Drop player A's internet. They must see the non-terminal reconnecting overlay (the connecting look),
  // NOT the severe kick/error panel.
  await contextA.setOffline(true);
  // The client's liveness watchdog notices the silence (~5s) and forces the reconnect path even though
  // the offline socket never cleanly closes, so the overlay appears shortly after.
  await expect(pageA.locator('#connectingOverlay')).toBeVisible({ timeout: 15_000 });
  await expect(pageA.locator('#connectingOverlay .connectingState')).toContainText(/reconnect|reconect/i);
  await expect(pageA.locator('#kickOverlay')).toBeHidden();

  // During the server grace, B must STILL see A — the roster keeps both, marking A "away" rather than
  // removing them. No instant "left".
  await expect(async () => {
    expect((await rosterNames(pageB)).length).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 5_000 });

  // Restore A's internet within the grace: they reconnect to online (overlay clears) and B keeps seeing
  // A resumed — no permanent leave.
  await contextA.setOffline(false);
  await expect(pageA.locator('#connectingOverlay')).toBeHidden({ timeout: 20_000 });
  await expect(async () => {
    expect((await rosterNames(pageB)).length).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 15_000 });

  await contextA.close();
  await contextB.close();
});

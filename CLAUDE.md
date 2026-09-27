# Trilliant — agent notes

Online Splendor-rules game. Static site, no build, no server. Read `README.md` for the architecture. Live at https://vladsrz.github.io/trilliant/ (GitHub Pages from `main`).

## Invariants — don't break these
- `js/engine.js` stays pure (no DOM, no network, no `Date.now()` in rules). Every rule change gets a test in `test/engine.test.mjs`; the simulation test must keep passing.
- The host is the only authority. Guests send intents; `HostRoom.process` → `applyAction` validates everything. Never apply a guest-supplied state.
- `viewFor` is the only thing that leaves the host. It must never include deck order, the RNG, or another player's blind reserves.
- Shuffles use `secureRandom` (CSPRNG). A seeded RNG is for tests only; a 32-bit seed can be brute-forced from the visible board.
- Messages that change a seat or make a move are pair-sealed (`hi`, `act`). Only presence (`host`, `knock`, `bye`) rides on the room key alone.
- Changing `RELAYS` in `js/net/bus.js` means updating `connect-src` in the CSP in `index.html`, or the browser will block the new relay.
- Names and chat render as text only (Preact escapes). Never `innerHTML` user data; the only `innerHTML` is the static gem sprite.

## Design
Deliberately restrained: plain dark table, flat ivory cards, no art/textures/gradients on cards or background. The cut gems (one shape per colour) are the only saturated colour and carry colour-blind legibility. Numerals use the UI face (IM Fell's old-style figures read "1" as "I"). Keep it that way unless asked.

## Verify before calling a change done
1. `npm test` and `npm run test:live`.
2. Serve locally, open two tabs (second one: "Join as another player"), play a few moves both ways.
3. `dev/states.html?s=…` screenshots at 1440×900, 1280×800 and 390×844 — no sideways scroll, board never spills out of its frame.

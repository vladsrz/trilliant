# Trilliant — agent notes

Online Splendor-rules game. Static site, no build, no server. Read `README.md` for the architecture. Live at https://vladsrz.github.io/trilliant/ (GitHub Pages from `main`).

## Invariants — don't break these
- `js/engine.js` stays pure (no DOM, no network, no `Date.now()` in rules). Every rule change gets a test in `test/engine.test.mjs`; the simulation test must keep passing.
- The host is the only authority. Guests send intents; `HostRoom.process` → `applyAction` validates everything. Never apply a guest-supplied state.
- `viewFor` is the only thing that leaves the host. It must never include deck order, the RNG, or another player's blind reserves. It also strips cards an opponent reserved from the board, in the seat and in the log, leaving only the level (the rulebook keeps reserved cards in hand). The host always starts games with `hideReserves` on; it is not a lobby setting.
- Shuffles use `secureRandom` (CSPRNG). A seeded RNG is for tests only; a 32-bit seed can be brute-forced from the visible board.
- Messages that change a seat or make a move are pair-sealed (`hi`, `act`). Only presence (`host`, `knock`, `bye`) rides on the room key alone.
- Changing `RELAYS` in `js/net/bus.js` means updating `connect-src` in the CSP in `index.html`, or the browser will block the new relay.
- The host enforces the turn clock (`HostRoom.checkClock`); `applyTimeout` is the only way a turn ends without a move. Guests only display the remaining time the host sends. Timeouts never count as passes. The time left is saved with the host record and picked up on reload (`resumeClock`); reloading the host tab must never refill a turn.
- Names and chat render as text only (Preact escapes). Never `innerHTML` user data; the only `innerHTML` is the static gem sprite.
- Bots are seats the host plays (`HostRoom.playBots`). A bot decides from `viewFor` its own seat, never the full state, and its move goes through `process` like a guest's. Bot ids contain a colon so they can never equal a player's key fingerprint. A bot must never hold the game up: a refused move falls back to `applyTimeout`, and `botAction` loosens up after a long spell without buying so two bots can't deadlock on each other's gems.

## Copy
Say "game", never "table"/"room" (lobby is fine). US spelling. Buttons say exactly what happens ("Create game", "Leave game", "Play again"). Every leave gets a red confirm.

## Design
Deliberately restrained: plain dark table, flat ivory cards, no art/textures/gradients on cards or background. The cut gems (one shape per color) are the only saturated color and keep colors colorblind-safe. Numerals use the UI face (IM Fell's old-style figures read "1" as "I"). Keep it that way unless asked.
Gem take animations must let players follow each color from the bank to a hand; use slow, visibly staggered flights because quick simultaneous movement hides what was taken.
Keep a selected bank gem centered inside its gold ring; moving the gem upward makes the ring look off-center.
Card states, quietest to loudest: hover (soft glow), buyable (yellow ring, always shown on your turn; the host's Hints setting only adds the "You need N more" line), selected (thicker yellow ring, lifted, glowing). Rings are outlines sized from `--cw` so neighbors never collide on phones.
Wide screens: the moves/chat panel is a short panel on top with the opponents straight under it, and the tray shares the bottom row half-and-half with your seat (`.dock`, a container query on `.main`). Narrower than that, `.dock` is `display: contents` so the phone tray stays sticky. `.game` is capped at 1460px and centered: past that the board has stopped growing and extra width only stretches the panels under it.
Gems picked in the tray are buttons with a cross (`Pick`); the cross takes that one gem back out, for takes and put-backs alike.

## Verify before calling a change done
1. `npm test` and `npm run test:live`.
2. Serve locally, open two tabs (second one: "Join as another player"), play a few moves both ways. Check a half-width window (~890×850): board stays side-by-side with the players column, no scrollbars inside panels.
3. `dev/states.html?s=…` screenshots at 1440×900, 1280×800 and 390×844 — no sideways scroll, board never spills out of its frame.

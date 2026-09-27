# Trilliant

Online gem-trading card game for 2–4 players, played by the rules of Splendor. Create a game, send the link, play in the browser. No accounts, no server to run.

**Play:** https://vladsrz.github.io/trilliant/

A trilliant is the triangular gem cut; here it's the ruby.

Fan-made. Not affiliated with Space Cowboys or Asmodee. No art or text from the published game; card costs and nobles are the base-game values (cross-checked against three independent public transcriptions and the rulebook example).

## Playing

1. Open the site, pick a name, **Create game**.
2. **Copy invite link** and send it. Whoever opens it gets a seat (2–4 players).
3. The host presses **Start game**.

The host's browser runs the game, so the host keeps that tab open. If it closes, the game pauses; the host reopens it from **Your games** on the start page (same browser) and everyone reconnects. Other players can close the tab and reopen the link any time without losing their seat. **Leave game** in the lobby gives your seat up.

**Turn timer:** the host picks Off, 1, 2 or 3 minutes in the lobby (default 3). The clock shows next to whose turn it is and goes red in the last 30 seconds. At zero that turn is skipped; if the player was mid put-back or choosing a noble, it's finished for them. The clock pauses while the host is away.

After a game the host can **Play again**; the lobby and results keep a running win count.

## How it works

- **Rules engine** (`js/engine.js`): pure functions over plain JSON. Validates every move, enforces the 10-gem cap, nobles, last round and the fewer-cards tiebreak. `applyTimeout` ends a turn when the clock runs out. Produces a per-player view that never contains deck order or another player's blind reserves.
- **Host-authoritative games** (`js/net/room.js`): the host seats players, applies moves, saves the game to `localStorage`, and sends each player their own view. Guests only send moves; the host re-checks each one.
- **Transport** (`js/net/mqtt.js`, `js/net/bus.js`): every message goes out on three free public MQTT relays at once (EMQX, HiveMQ, Mosquitto) over secure WebSockets; receivers drop duplicates. One relay being down or blocked doesn't matter.
- **Encryption** (`js/net/crypto.js`): the invite link's `#fragment` holds a 128-bit room secret that never reaches any server. It derives the relay topic and an AES-GCM key that seals every message, so relays only see ciphertext. Each browser also has an ECDH key pair; its fingerprint is the player's id and host↔player traffic is sealed again with a pairwise key, so players can't read each other's private view or forge each other's moves.
- **UI** (`js/ui/`): Preact + htm, vendored (13 kB), no build step.

### Known limits

- The host's browser holds the whole game, deck order included, so a host with dev tools could peek or cheat. Guests can't.
- Public relays are best-effort services. Moves are retried until the host acknowledges them, and state re-syncs on every heartbeat, so a dropped message costs a second or two, not the game.
- Phones pause background tabs. If the host locks their phone the game waits until they come back.
- Some school or work networks block the relays' ports. Phone data works.

## Develop

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Then open http://127.0.0.1:8765/. Two players in one browser: open the invite link in a second tab and choose **Join as another player**.

```bash
npm test            # rules engine + turn clock: targeted cases and 1,500 simulated games checked after every move
npm run test:live   # a full host-vs-guest game over the real relays, with reloads mid-game
```

`dev/` (git-ignored) holds a state viewer: `dev/states.html?s=mid|discard|noble|final|over|waiting`.

## Deploy

Static files, no build. GitHub Pages serves the repo root from `main`.

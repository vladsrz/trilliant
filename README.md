# Trilliant

Online gem-trading card game for 2–4 players, played by the rules of Splendor. Open a table, send the link, play in the browser. No accounts, no server to run.

**Play:** https://vladsrz.github.io/trilliant/

A trilliant is the triangular gem cut; here it's the ruby.

Fan-made. Not affiliated with Space Cowboys or Asmodee. No art or text from the published game; card costs and nobles are the base-game values (cross-checked against three independent public transcriptions and the rulebook example).

## Playing

1. Open the site, pick a name, **Open a table**.
2. **Copy invite link** and send it. Whoever opens it takes a seat (up to 4).
3. The host presses **Start game**.

The host's browser runs the table, so the host keeps that tab open. Closing it pauses the game; reopening the table from **Your tables** on the start page (same browser) picks it back up. Guests can close and reopen the link at any time and keep their seat.

After a game the host can **Rematch**; the lobby and results show a running win count for the table.

## How it works

- **Rules engine** (`js/engine.js`): pure functions over plain JSON. Validates every move, enforces the 10-gem cap, nobles, last round and the fewer-cards tiebreak. Produces a per-player view that never contains deck order or another player's blind reserves.
- **Host-authoritative rooms** (`js/net/room.js`): the host seats players, applies moves, saves the table to `localStorage`, and sends each player their own view. Guests only send moves; the host re-checks each one.
- **Transport** (`js/net/mqtt.js`, `js/net/bus.js`): every message goes out on three free public MQTT relays at once (EMQX, HiveMQ, Mosquitto) over secure WebSockets; receivers drop duplicates. One relay being down or blocked doesn't matter.
- **Encryption** (`js/net/crypto.js`): the invite link's `#fragment` holds a 128-bit room secret that never reaches any server. It derives the relay topic and an AES-GCM key that seals every message, so relays only see ciphertext. Each browser also has an ECDH key pair; its fingerprint is the player's id and host↔player traffic is sealed again with a pairwise key, so players can't read each other's private view or forge each other's moves.
- **UI** (`js/ui/`): Preact + htm, vendored (13 kB), no build step.

### Known limits

- The host's browser holds the whole game, deck order included, so a host with dev tools could peek or cheat. Guests can't.
- Public relays are best-effort services. Moves are retried until the host acknowledges them, and state re-syncs on every heartbeat, so a dropped message costs a second or two, not the game.
- Phones pause background tabs. If the host locks their phone the table waits until they come back.

## Develop

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Then open http://127.0.0.1:8765/. Two players in one browser: open the invite link in a second tab and choose **Join as another player**.

```bash
npm test            # rules engine: targeted cases + 1,500 simulated games checked after every move
npm run test:live   # a full host-vs-guest game over the real relays, with reloads mid-game
```

`dev/` (git-ignored) holds a state viewer: `dev/states.html?s=mid|discard|noble|final|over|waiting`.

## Deploy

Static files, no build. GitHub Pages serves the repo root from `main`.

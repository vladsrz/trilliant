// A room's message bus: every message is sealed with the room key and
// published on several independent public relays at once. Receivers drop
// duplicates, anything they can't decrypt, and anything not meant for them.
// One relay going down (or being blocked on someone's network) is invisible.

import { MqttLink } from './mqtt.js';
import { seal, open, randomId } from './crypto.js';

export const RELAYS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

const SEEN_LIMIT = 2000;

export class Bus {
  constructor({ topic, key, selfId, onMessage, onStatus, relays = RELAYS }) {
    this.key = key;
    this.selfId = selfId;
    this.onMessage = onMessage;
    this.onStatus = onStatus || (() => {});
    this.seen = new Set();
    this.seenOrder = [];
    this.links = relays.map((url) => new MqttLink(url, {
      topic,
      onMessage: (bytes) => this.receive(bytes),
      onState: () => this.onStatus(this.status()),
    }));
  }

  start() { for (const l of this.links) l.start(); }
  stop() { for (const l of this.links) l.stop(); }
  wake() { for (const l of this.links) l.kick(); }

  status() {
    const up = this.links.filter((l) => l.up).length;
    return { up, total: this.links.length };
  }

  async send(type, data, to) {
    const env = { i: randomId(), f: this.selfId, t: type, d: data };
    if (to) env.to = to;
    this.remember(env.i);
    const bytes = await seal(this.key, env);
    let sent = 0;
    for (const l of this.links) if (l.publish(bytes)) sent++;
    return sent > 0;
  }

  async receive(bytes) {
    const env = await open(this.key, bytes);
    if (!env || typeof env !== 'object') return;
    const { i, f, t, to } = env;
    if (typeof i !== 'string' || typeof f !== 'string' || typeof t !== 'string') return;
    if (f === this.selfId || (to && to !== this.selfId)) return;
    if (this.seen.has(i)) return;
    this.remember(i);
    this.onMessage(env);
  }

  remember(id) {
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > SEEN_LIMIT) this.seen.delete(this.seenOrder.shift());
  }
}

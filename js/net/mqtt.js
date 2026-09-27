// Minimal MQTT 3.1.1 client over WebSocket: connect, subscribe to one topic,
// publish and receive at QoS 0, keep-alive pings, reconnect with backoff.
// That is all a room needs, and it keeps the page free of a 100 kB dependency.

const enc = new TextEncoder();
const dec = new TextDecoder();

const CONNECT = 0x10;
const PUBLISH = 0x30;
const SUBSCRIBE = 0x82;
const PINGREQ = new Uint8Array([0xc0, 0x00]);
const DISCONNECT = new Uint8Array([0xe0, 0x00]);
const BACKOFF = [800, 1500, 3000, 6000, 12000, 20000];
const PING_EVERY = 20000;
const PING_GRACE = 12000;
const CONNECT_TIMEOUT = 9000;

function varLength(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}

function mqttString(s) {
  const b = enc.encode(s);
  const out = new Uint8Array(2 + b.length);
  out[0] = b.length >> 8;
  out[1] = b.length & 0xff;
  out.set(b, 2);
  return out;
}

function packet(header, ...parts) {
  const bodyLen = parts.reduce((n, p) => n + p.length, 0);
  const len = varLength(bodyLen);
  const out = new Uint8Array(1 + len.length + bodyLen);
  out[0] = header;
  out.set(len, 1);
  let o = 1 + len.length;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const clientId = () => 'fc' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-6);

export class MqttLink {
  constructor(url, { topic, onMessage, onState }) {
    this.url = url;
    this.topic = topic;
    this.onMessage = onMessage;
    this.onState = onState || (() => {});
    this.state = 'idle';
    this.gen = 0;
    this.attempt = 0;
    this.stopped = true;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    this.teardown(true);
    this.setState('idle');
  }

  // Force a fresh connection now (e.g. when a phone wakes the tab).
  kick() {
    if (this.stopped) return;
    if (this.state === 'up' && Date.now() - this.lastRx < PING_EVERY) return;
    this.teardown(false);
    this.open();
  }

  get up() { return this.state === 'up'; }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.onState(s, this);
  }

  open() {
    const gen = ++this.gen;
    this.setState('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url, 'mqtt');
    } catch {
      this.retry(gen);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.buf = new Uint8Array(0);
    this.lastRx = Date.now();
    this.connectTimer = setTimeout(() => this.drop(gen), CONNECT_TIMEOUT);
    ws.onopen = () => {
      if (gen !== this.gen) return;
      const flags = new Uint8Array([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x3c]); // "MQTT", v4, clean session, keepalive 60s
      ws.send(packet(CONNECT, flags, mqttString(clientId())));
    };
    ws.onmessage = (e) => {
      if (gen !== this.gen) return;
      this.lastRx = Date.now();
      this.feed(new Uint8Array(e.data), gen);
    };
    ws.onclose = () => this.drop(gen);
    ws.onerror = () => this.drop(gen);
  }

  feed(chunk, gen) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    let buf = merged;
    for (;;) {
      if (buf.length < 2) break;
      let len = 0;
      let mult = 1;
      let i = 1;
      let complete = false;
      for (; i < Math.min(buf.length, 5); i++) {
        len += (buf[i] & 0x7f) * mult;
        mult *= 128;
        if (!(buf[i] & 0x80)) { complete = true; i++; break; }
      }
      if (!complete) { if (buf.length >= 5) return this.drop(gen); break; }
      if (buf.length < i + len) break;
      this.handle(buf[0], buf.subarray(i, i + len), gen);
      if (gen !== this.gen) return;
      buf = buf.subarray(i + len);
    }
    this.buf = buf.slice();
  }

  handle(header, body, gen) {
    switch (header >> 4) {
      case 2: // CONNACK
        if (body[1] !== 0) return this.drop(gen);
        this.ws.send(packet(SUBSCRIBE, new Uint8Array([0x00, 0x01]), mqttString(this.topic), new Uint8Array([0x00])));
        break;
      case 9: // SUBACK
        if (body[2] === 0x80) return this.drop(gen);
        clearTimeout(this.connectTimer);
        this.attempt = 0;
        this.setState('up');
        this.schedulePing(gen);
        break;
      case 3: { // PUBLISH
        const qos = (header >> 1) & 3;
        const tlen = (body[0] << 8) | body[1];
        const topic = dec.decode(body.subarray(2, 2 + tlen));
        const off = 2 + tlen + (qos > 0 ? 2 : 0);
        if (topic === this.topic) this.onMessage(body.slice(off), this);
        break;
      }
      default: // PINGRESP and anything else just count as liveness
        break;
    }
  }

  schedulePing(gen) {
    clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => {
      if (gen !== this.gen || this.state !== 'up') return;
      try { this.ws.send(PINGREQ); } catch { return this.drop(gen); }
      const sent = Date.now();
      this.pingTimer = setTimeout(() => {
        if (gen !== this.gen) return;
        if (this.lastRx < sent) this.drop(gen);
        else this.schedulePing(gen);
      }, PING_GRACE);
    }, PING_EVERY);
  }

  publish(bytes) {
    if (this.state !== 'up') return false;
    try {
      this.ws.send(packet(PUBLISH, mqttString(this.topic), bytes));
      return true;
    } catch {
      this.drop(this.gen);
      return false;
    }
  }

  drop(gen) {
    if (gen !== this.gen) return;
    this.teardown(false);
    if (this.stopped) return;
    this.setState('down');
    this.retry(gen);
  }

  retry(gen) {
    const wait = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)] * (0.75 + Math.random() * 0.5);
    this.attempt += 1;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (!this.stopped && gen === this.gen) this.open();
    }, wait);
  }

  teardown(polite) {
    this.gen += 1;
    clearTimeout(this.connectTimer);
    clearTimeout(this.pingTimer);
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      if (polite && ws.readyState === 1) ws.send(DISCONNECT);
      ws.close();
    } catch { /* already gone */ }
  }
}

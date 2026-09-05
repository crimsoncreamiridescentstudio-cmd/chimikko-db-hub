// Ephemeral display cache only. Firestore Rules remain authoritative for writes.
export class ReadCache {
  constructor({ ttl = 60000, max = 48, now = Date.now } = {}) {
    this.ttl = ttl; this.max = max; this.now = now;
    this.values = new Map(); this.inflight = new Map();
  }
  peek(key) {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) { this.values.delete(key); return undefined; }
    return entry.value;
  }
  set(key, value) {
    this.inflight.delete(key);
    this.values.delete(key);
    this.values.set(key, { value, expires: this.now() + this.ttl });
    while (this.values.size > this.max) this.values.delete(this.values.keys().next().value);
  }
  async get(key, read) {
    const cached = this.peek(key);
    if (cached !== undefined) return cached;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const task = Promise.resolve().then(read).then(value => {
      // A pending response must never repopulate a cleared/revoked cache.
      if (this.inflight.get(key) === task) this.set(key, value);
      return value;
    }).finally(() => { if (this.inflight.get(key) === task) this.inflight.delete(key); });
    this.inflight.set(key, task);
    return task;
  }
  drop(prefix) {
    for (const key of this.values.keys()) if (key.startsWith(prefix)) this.values.delete(key);
    for (const key of this.inflight.keys()) if (key.startsWith(prefix)) this.inflight.delete(key);
  }
  clear() { this.values.clear(); this.inflight.clear(); }
}
export async function readWithDeadline(task, ms = 15000) {
  let timer;
  try {
    return await Promise.race([task, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('通信に時間がかかっています。接続を確認して再度お試しください。'), { code: 'deadline-exceeded' })), ms);
    })]);
  } finally { clearTimeout(timer); }
}

// Retry reads only. Never repeat writes or permission/validation errors.
export async function retryRead(read, { current = () => true, attempts = 3,
  timeout = 15000, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!current()) throw Object.assign(new Error('読み込みを終了しました。'), { code: 'cancelled' });
    try { return await readWithDeadline(Promise.resolve().then(read), timeout); }
    catch (error) {
      if (!['unavailable', 'deadline-exceeded', 'auth/network-request-failed'].includes(error?.code)
        || attempt === attempts - 1 || !current()) throw error;
      await delay(500 * 2 ** attempt);
    }
  }
}

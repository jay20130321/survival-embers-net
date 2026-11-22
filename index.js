/**
 * 孤岛余烬联机：房间码 + 权威世界 tick
 * 启动：npm start   端口：8791（Render 用 PORT）
 * 路径：/ws · /health
 */
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8791;
const TICK_HZ = 12;
const TICK_MS = 1000 / TICK_HZ;
const DAY_LENGTH = 480; // 秒，与客户端一致
const MAX_PLAYERS = 8;
const HALF = 48;
const CELL = 2;

const clients = new Map();
const rooms = new Map();

const RECIPES = {
  stick: { out: "stick", count: 4, need: { wood: 1 } },
  axe: { out: "axe", count: 1, need: { stick: 2, stone: 3 } },
  pickaxe: { out: "pickaxe", count: 1, need: { stick: 2, stone: 3 } },
  torch: { out: "torch", count: 2, need: { stick: 1, fiber: 1 } },
  campfire: { out: "campfire", count: 1, need: { wood: 5, stone: 3 } },
  wall: { out: "wall", count: 2, need: { wood: 4 } },
  floor: { out: "floor", count: 4, need: { wood: 2 } },
  chest: { out: "chest", count: 1, need: { wood: 8 } },
  cooked_meat: { out: "cooked_meat", count: 1, need: { raw_meat: 1 }, near_fire: true },
};

const PLACE_ITEM = {
  campfire: "campfire",
  wall: "wall",
  floor: "floor",
  chest: "chest",
  torch: "torch",
};

function uid() {
  return crypto.randomBytes(6).toString("hex");
}

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 5; i++) c += alphabet[(Math.random() * alphabet.length) | 0];
  if (rooms.has(c)) return makeCode();
  return c;
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcastRoom(room, obj, exceptId) {
  for (const id of room.members) {
    if (exceptId && id === exceptId) continue;
    const c = clients.get(id);
    if (c) send(c.ws, obj);
  }
}

function lobbyPayload(room) {
  const members = [];
  for (const id of room.members) {
    const c = clients.get(id);
    if (!c) continue;
    members.push({ id, name: c.name });
  }
  return { t: "lobby", code: room.code, host: room.hostId, members };
}

function hash(seed, x, z) {
  let n = (seed * 374761393 + x * 668265263 + z * 2147483647) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  n = n ^ (n >>> 16);
  return (n >>> 0) / 4294967295;
}

function noise(seed, x, z) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const v00 = hash(seed, xi, zi);
  const v10 = hash(seed, xi + 1, zi);
  const v01 = hash(seed, xi, zi + 1);
  const v11 = hash(seed, xi + 1, zi + 1);
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const a = v00 + (v10 - v00) * u;
  const b = v01 + (v11 - v01) * u;
  return (a + (b - a) * v) * 2 - 1;
}

function islandMask(x, z) {
  const d = Math.hypot(x, z) / HALF;
  return Math.max(0, Math.min(1, 1 - d * d));
}

function heightAt(seed, x, z) {
  const n1 = noise(seed, x * 0.045, z * 0.045);
  const n2 = noise(seed + 17, x * 0.12, z * 0.12) * 0.35;
  const island = islandMask(x, z);
  return Math.max(0, (n1 * 0.55 + n2 + 0.15) * island * 6.5);
}

function isLand(seed, x, z) {
  return heightAt(seed, x, z) > 0.35 && islandMask(x, z) > 0.18;
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildResourceList(seed) {
  const rng = mulberry32(seed >>> 0);
  const list = [];
  let id = 0;
  for (let ix = -22; ix <= 22; ix++) {
    for (let iz = -22; iz <= 22; iz++) {
      const x = ix * CELL + (rng() - 0.5) * 0.8;
      const z = iz * CELL + (rng() - 0.5) * 0.8;
      if (!isLand(seed, x, z)) continue;
      const h = heightAt(seed, x, z);
      const roll = rng();
      let kind = "";
      if (roll < 0.1 && h > 1.2) kind = "tree";
      else if (roll < 0.16 && h > 0.8) kind = "rock";
      else if (roll < 0.2) kind = "bush";
      else if (roll < 0.215 && h > 0.6) kind = "animal";
      if (!kind) continue;
      const hp = kind === "rock" ? 5 : kind === "tree" ? 4 : kind === "animal" ? 3 : 2;
      list.push({
        id,
        kind,
        x: Math.round(x * 100) / 100,
        z: Math.round(z * 100) / 100,
        y: Math.round(h * 100) / 100,
        hp,
        max: hp,
      });
      id++;
    }
  }
  return list;
}

function spawnPoints(seed, count = 8) {
  const rng = mulberry32((seed + 99) >>> 0);
  const pts = [];
  let tries = 0;
  while (pts.length < count && tries < 400) {
    tries++;
    const x = (rng() - 0.5) * 36;
    const z = (rng() - 0.5) * 36;
    if (isLand(seed, x, z) && heightAt(seed, x, z) > 0.8) {
      pts.push({ x, y: heightAt(seed, x, z) + 0.1, z });
    }
  }
  if (!pts.length) pts.push({ x: 0, y: 2, z: 0 });
  return pts;
}

function dropFor(kind, hpAfter) {
  if (kind === "tree") return { item: "wood", count: hpAfter > 0 ? 1 : 2 };
  if (kind === "rock") return { item: "stone", count: 1 };
  if (kind === "bush") return hpAfter <= 0 ? { item: "berry", count: 2 } : { item: "fiber", count: 1 };
  if (kind === "animal") return hpAfter <= 0 ? { item: "raw_meat", count: 2 } : { item: "fiber", count: 1 };
  return null;
}

class Player {
  constructor(id, name, x, y, z) {
    this.id = id;
    this.name = name;
    this.x = x;
    this.y = y;
    this.z = z;
    this.fy = 0;
    this.hp = 100;
    this.hunger = 80;
    this.thirst = 80;
    this.input = {};
  }

  applyInput(inp) {
    this.input = inp || {};
    const cx = Number(inp.x);
    const cy = Number(inp.y);
    const cz = Number(inp.z);
    if (Number.isFinite(cx) && Number.isFinite(cz)) {
      const dx = cx - this.x;
      const dz = cz - this.z;
      const d = Math.hypot(dx, dz);
      if (d < 15) {
        this.x += dx * 0.55;
        this.z += dz * 0.55;
        if (Number.isFinite(cy)) this.y = cy;
      }
    }
    if (Number.isFinite(Number(inp.fy))) this.fy = Number(inp.fy);
    if (Number.isFinite(Number(inp.hp))) this.hp = Number(inp.hp);
    if (Number.isFinite(Number(inp.hunger))) this.hunger = Number(inp.hunger);
    if (Number.isFinite(Number(inp.thirst))) this.thirst = Number(inp.thirst);
  }

  simulate(dt, seed) {
    const inp = this.input || {};
    const mx = Number(inp.mx) || 0;
    const mz = Number(inp.mz) || 0;
    const sprint = !!inp.sprint;
    const len = Math.hypot(mx, mz);
    let dx = mx;
    let dz = mz;
    if (len > 1) {
      dx /= len;
      dz /= len;
    }
    const spd = sprint ? 9 : 6.2;
    this.x += dx * spd * dt;
    this.z += dz * spd * dt;
    this.y = heightAt(seed, this.x, this.z) + 0.05;
    if (len > 0.05) this.fy = Math.atan2(dx, dz);
  }

  snap() {
    return {
      id: this.id,
      name: this.name,
      x: Math.round(this.x * 100) / 100,
      y: Math.round(this.y * 100) / 100,
      z: Math.round(this.z * 100) / 100,
      fy: Math.round(this.fy * 1000) / 1000,
      hp: this.hp,
      hunger: this.hunger,
      thirst: this.thirst,
    };
  }
}

class Room {
  constructor(code, hostId) {
    this.code = code;
    this.hostId = hostId;
    this.members = new Set([hostId]);
    this.playing = false;
    this.seed = (Math.random() * 1e9) | 0;
    this.players = new Map();
    this.resources = new Map();
    this.buildings = [];
    this.nextBuildId = 1;
    this.time = 0.18;
    this._timer = null;
    this.spawns = [];
  }

  start() {
    if (this.playing) return;
    this.playing = true;
    this.resources.clear();
    for (const r of buildResourceList(this.seed)) {
      this.resources.set(r.id, { ...r });
    }
    this.spawns = spawnPoints(this.seed, 8);
    this.buildings = [];
    this.nextBuildId = 1;
    this.time = 0.18;
    this.players.clear();
    let i = 0;
    for (const id of this.members) {
      const c = clients.get(id);
      if (!c) continue;
      const sp = this.spawns[i % this.spawns.length];
      this.players.set(id, new Player(id, c.name, sp.x, sp.y, sp.z));
      i++;
    }
    const resList = [];
    for (const r of this.resources.values()) {
      resList.push({
        id: r.id,
        kind: r.kind,
        x: r.x,
        y: r.y,
        z: r.z,
        hp: r.hp,
        max: r.max,
      });
    }
    broadcastRoom(this, { t: "start", seed: this.seed, resources: resList });
    this._timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    this.playing = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.players.clear();
  }

  nearFire(p) {
    for (const b of this.buildings) {
      if (b.kind !== "campfire" && b.kind !== "torch") continue;
      if (Math.hypot(p.x - b.x, p.z - b.z) < 4.5) return true;
    }
    return false;
  }

  handleAction(pid, msg) {
    const p = this.players.get(pid);
    if (!p || !this.playing) return;
    const op = String(msg.op || "");
    if (op === "harvest") {
      const rid = Number(msg.rid);
      const res = this.resources.get(rid);
      if (!res || res.hp <= 0) return;
      if (Math.hypot(p.x - res.x, p.z - res.z) > 4.5) {
        send(clients.get(pid).ws, { t: "event", op: "toast", to: pid, text: "太远了" });
        return;
      }
      const power = Math.max(1, Math.min(3, Number(msg.power) || 1));
      res.hp = Math.max(0, res.hp - power);
      const drop = dropFor(res.kind, res.hp);
      broadcastRoom(this, {
        t: "event",
        op: "res",
        rid: res.id,
        hp: res.hp,
        drop,
        to: pid,
      });
      return;
    }
    if (op === "place") {
      const kind = String(msg.kind || "");
      if (!PLACE_ITEM[kind]) return;
      const x = Number(msg.x);
      const y = Number(msg.y);
      const z = Number(msg.z);
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      if (Math.hypot(p.x - x, p.z - z) > 6) {
        send(clients.get(pid).ws, { t: "event", op: "toast", to: pid, text: "太远了" });
        return;
      }
      const building = {
        id: this.nextBuildId++,
        kind,
        x,
        y: Number.isFinite(y) ? y : heightAt(this.seed, x, z),
        z,
        ry: Number(msg.ry) || 0,
        owner: pid,
      };
      this.buildings.push(building);
      broadcastRoom(this, { t: "event", op: "build", building, kind, to: pid });
      return;
    }
    if (op === "craft") {
      const recipe = RECIPES[String(msg.recipe || "")];
      if (!recipe) return;
      if (recipe.near_fire && !this.nearFire(p)) {
        send(clients.get(pid).ws, { t: "event", op: "toast", to: pid, text: "需要靠近营火/火把" });
        return;
      }
      // 信任客户端扣材料（首期）；广播确认
      broadcastRoom(this, {
        t: "event",
        op: "craft_ok",
        to: pid,
        out: recipe.out,
        count: recipe.count,
        need: recipe.need,
      });
    }
  }

  tick() {
    const dt = TICK_MS / 1000;
    this.time = (this.time + dt / DAY_LENGTH) % 1;
    for (const p of this.players.values()) {
      p.simulate(dt, this.seed);
    }
    const players = [];
    for (const p of this.players.values()) players.push(p.snap());
    broadcastRoom(this, {
      t: "snap",
      players,
      time: Math.round(this.time * 10000) / 10000,
      tMs: Date.now(),
    });
  }
}

function findRoomOf(pid) {
  for (const room of rooms.values()) {
    if (room.members.has(pid)) return room;
  }
  return null;
}

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ ok: true, game: "survival-embers", rooms: rooms.size, clients: clients.size }));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  let pid = null;

  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(String(buf));
    } catch {
      return;
    }
    const t = String(msg.t || "");
    if (t === "hello") {
      pid = String(msg.id || uid());
      const existing = clients.get(pid);
      if (existing && existing.ws !== ws) {
        try {
          existing.ws.close();
        } catch {}
      }
      clients.set(pid, { ws, id: pid, name: String(msg.name || "幸存者").slice(0, 16) });
      send(ws, { t: "welcome", id: pid });
      return;
    }
    if (!pid || !clients.has(pid)) return;
    const client = clients.get(pid);
    if (msg.name) client.name = String(msg.name).slice(0, 16);

    if (t === "create") {
      const old = findRoomOf(pid);
      if (old) {
        old.members.delete(pid);
        if (old.members.size === 0) {
          old.stop();
          rooms.delete(old.code);
        } else if (old.hostId === pid) {
          old.hostId = [...old.members][0];
          broadcastRoom(old, lobbyPayload(old));
        }
      }
      const code = makeCode();
      const room = new Room(code, pid);
      rooms.set(code, room);
      send(ws, lobbyPayload(room));
      return;
    }

    if (t === "join") {
      const code = String(msg.code || "").toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        send(ws, { t: "err", text: "房间不存在" });
        return;
      }
      if (room.playing) {
        send(ws, { t: "err", text: "对局已开始" });
        return;
      }
      if (room.members.size >= MAX_PLAYERS) {
        send(ws, { t: "err", text: "房间已满" });
        return;
      }
      const old = findRoomOf(pid);
      if (old && old !== room) {
        old.members.delete(pid);
        if (old.members.size === 0) {
          old.stop();
          rooms.delete(old.code);
        } else broadcastRoom(old, lobbyPayload(old));
      }
      room.members.add(pid);
      broadcastRoom(room, lobbyPayload(room));
      return;
    }

    if (t === "leave") {
      const room = findRoomOf(pid);
      if (!room) return;
      room.members.delete(pid);
      room.players.delete(pid);
      if (room.members.size === 0) {
        room.stop();
        rooms.delete(room.code);
      } else {
        if (room.hostId === pid) room.hostId = [...room.members][0];
        broadcastRoom(room, lobbyPayload(room));
      }
      return;
    }

    if (t === "start") {
      const room = findRoomOf(pid);
      if (!room) return;
      if (room.hostId !== pid) {
        send(ws, { t: "err", text: "只有房主能开始" });
        return;
      }
      room.start();
      return;
    }

    if (t === "input") {
      const room = findRoomOf(pid);
      if (!room || !room.playing) return;
      const p = room.players.get(pid);
      if (p) p.applyInput(msg);
      return;
    }

    if (t === "action") {
      const room = findRoomOf(pid);
      if (!room || !room.playing) return;
      room.handleAction(pid, msg);
      return;
    }

    if (t === "chat") {
      const room = findRoomOf(pid);
      if (!room) return;
      const text = String(msg.text || "").slice(0, 80);
      if (!text) return;
      broadcastRoom(room, { t: "chat", from: client.name, text });
    }
  });

  ws.on("close", () => {
    if (!pid) return;
    const room = findRoomOf(pid);
    clients.delete(pid);
    if (!room) return;
    room.members.delete(pid);
    room.players.delete(pid);
    if (room.members.size === 0) {
      room.stop();
      rooms.delete(room.code);
    } else {
      if (room.hostId === pid) room.hostId = [...room.members][0];
      broadcastRoom(room, lobbyPayload(room));
      if (room.playing) {
        broadcastRoom(room, { t: "sys", text: "有玩家离开了孤岛" });
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`[survival-embers] listening on :${PORT}  ws path /ws`);
});

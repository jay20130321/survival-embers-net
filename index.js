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
  rope: { out: "rope", count: 2, need: { fiber: 4 } },
  charcoal: { out: "charcoal", count: 2, need: { wood: 2 }, near_fire: true },
  iron_ingot: { out: "iron_ingot", count: 1, need: { iron_ore: 2, charcoal: 1 }, near_fire: true },
  axe: { out: "axe", count: 1, need: { stick: 2, stone: 3 } },
  pickaxe: { out: "pickaxe", count: 1, need: { stick: 2, stone: 3 } },
  iron_axe: { out: "iron_axe", count: 1, need: { stick: 2, iron_ingot: 3 } },
  iron_pickaxe: { out: "iron_pickaxe", count: 1, need: { stick: 2, iron_ingot: 3 } },
  fishing_rod: { out: "fishing_rod", count: 1, need: { stick: 3, rope: 2 } },
  hoe: { out: "hoe", count: 1, need: { stick: 2, stone: 2 } },
  wheat_seed: { out: "wheat_seed", count: 2, need: { wheat: 1 } },
  berry_seed: { out: "berry_seed", count: 2, need: { berry: 1 } },
  bread: { out: "bread", count: 1, need: { wheat: 3 }, near_fire: true },
  club: { out: "club", count: 1, need: { wood: 3, stick: 1 } },
  spear: { out: "spear", count: 1, need: { stick: 2, bone: 2, rope: 1 } },
  iron_sword: { out: "iron_sword", count: 1, need: { stick: 1, iron_ingot: 3 } },
  shadow_blade: { out: "shadow_blade", count: 1, need: { iron_ingot: 2, shadow_shard: 3, bone: 1 } },
  cloth_armor: { out: "cloth_armor", count: 1, need: { fiber: 8 } },
  hide_armor: { out: "hide_armor", count: 1, need: { hide: 4, rope: 2 } },
  bone_armor: { out: "bone_armor", count: 1, need: { bone: 6, hide: 2, rope: 2 } },
  iron_armor: { out: "iron_armor", count: 1, need: { iron_ingot: 5, hide: 2 } },
  bandage: { out: "bandage", count: 2, need: { fiber: 3 } },
  waterskin: { out: "waterskin", count: 1, need: { fiber: 3, stick: 1 } },
  cooked_meat: { out: "cooked_meat", count: 1, need: { raw_meat: 1 }, near_fire: true },
  cooked_fish: { out: "cooked_fish", count: 1, need: { raw_fish: 1 }, near_fire: true },
  stew: { out: "stew", count: 1, need: { cooked_meat: 1, berry: 2, fresh_water: 1 }, near_fire: true },
  torch: { out: "torch", count: 2, need: { stick: 1, fiber: 1 } },
  campfire: { out: "campfire", count: 1, need: { wood: 5, stone: 3 } },
  wall: { out: "wall", count: 2, need: { wood: 4 } },
  floor: { out: "floor", count: 4, need: { wood: 2 } },
  chest: { out: "chest", count: 1, need: { wood: 8 } },
  bed: { out: "bed", count: 1, need: { wood: 6, fiber: 4, hide: 1 } },
  spike: { out: "spike", count: 2, need: { wood: 3, stick: 2 } },
};

const PLACE_ITEM = {
  campfire: "campfire",
  wall: "wall",
  floor: "floor",
  chest: "chest",
  torch: "torch",
  bed: "bed",
  spike: "spike",
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

function hash(seed, x, z) {
  let n = (seed * 374761393 + x * 668265263 + z * 2147483647) | 0;
  n = ((n ^ (n >>> 13)) * 1274126177) | 0;
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
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
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
      let hp = 3;
      if (kind === "tree") hp = 4;
      if (kind === "rock") hp = 5;
      if (kind === "bush") hp = 2;
      if (kind === "animal") hp = 3;
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

function dropFor(kind, hpAfter, rid) {
  if (kind === "tree") return { item: "wood", count: hpAfter > 0 ? 1 : 2 };
  if (kind === "rock") {
    if (hpAfter <= 0 && (rid * 17 + 3) % 5 === 0) return { item: "iron_ore", count: 1 };
    return { item: "stone", count: 1 };
  }
  if (kind === "bush") return hpAfter <= 0 ? { item: "berry", count: 2 } : { item: "fiber", count: 1 };
  if (kind === "animal") {
    if (hpAfter > 0) return { item: "fiber", count: 1 };
    const roll = (rid * 13) % 3;
    if (roll === 0) return { item: "raw_meat", count: 2 };
    if (roll === 1) return { item: "hide", count: 1 };
    return { item: "bone", count: 2 };
  }
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
    this.swim = false;
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
    if (typeof inp.swim === "boolean") this.swim = inp.swim;
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
    // 优先用客户端上报；否则用地形推断
    if (typeof inp.swim === "boolean") {
      this.swim = inp.swim;
    } else {
      this.swim = !isLand(seed, this.x, this.z);
    }
    const spd = this.swim ? (sprint ? 5.2 : 3.6) : sprint ? 9 : 6.2;
    this.x += dx * spd * dt;
    this.z += dz * spd * dt;
    if (this.swim) {
      this.y = 0.38;
    } else {
      this.y = heightAt(seed, this.x, this.z) + 0.05;
    }
    if (len > 0.05) this.fy = Math.atan2(-dx, -dz);
  }

  snap() {
    return {
      id: this.id,
      name: this.name,
      x: Math.round(this.x * 100) / 100,
      y: Math.round(this.y * 100) / 100,
      z: Math.round(this.z * 100) / 100,
      fy: Math.round(this.fy * 1000) / 1000,
      swim: !!this.swim,
      hp: Math.round(this.hp),
      hunger: Math.round(this.hunger),
      thirst: Math.round(this.thirst),
    };
  }
}

class Room {
  constructor(code, hostId) {
    this.code = code;
    this.hostId = hostId;
    this.players = new Map();
    this.seed = ((Math.random() * 999999) | 0) + 1;
    this.time = 0.42; // 开局白天，与客户端 set_daytime 一致
    this.resources = [];
    this.buildings = [];
    this.nextBuildId = 1;
    this.started = false;
  }

  start() {
    this.started = true;
    this.resources = [];
    for (const r of buildResourceList(this.seed)) {
      this.resources.push({ ...r });
    }
    this.buildings = [];
    this.nextBuildId = 1;
  }

  tick(dt) {
    this.time = (this.time + dt / DAY_LENGTH) % 1;
    for (const p of this.players.values()) p.simulate(dt, this.seed);
  }

  snapshot() {
    return {
      t: "snap",
      time: this.time,
      seed: this.seed,
      players: [...this.players.values()].map((p) => p.snap()),
      resources: this.resources.map((r) => ({
        id: r.id,
        kind: r.kind,
        x: r.x,
        y: r.y,
        z: r.z,
        hp: r.hp,
        max: r.max,
      })),
      buildings: this.buildings,
    };
  }

  handleAction(pid, msg) {
    const op = msg.op;
    const p = this.players.get(pid);
    if (!p) return;
    if (op === "harvest") {
      const rid = Number(msg.rid);
      const power = Math.max(1, Number(msg.power) || 1);
      const r = this.resources.find((x) => x.id === rid);
      if (!r || r.hp <= 0) return;
      r.hp = Math.max(0, r.hp - power);
      const drop = dropFor(r.kind, r.hp, r.id);
      broadcastRoom(this, { t: "event", op: "harvest", rid, hp: r.hp, drop, to: pid });
      return;
    }
    if (op === "place") {
      const kind = String(msg.kind || "");
      if (!PLACE_ITEM[kind]) return;
      const building = {
        id: this.nextBuildId++,
        kind,
        x: Number(msg.x) || 0,
        y: Number(msg.y) || 0,
        z: Number(msg.z) || 0,
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
      broadcastRoom(this, { t: "event", op: "craft_ok", recipe: msg.recipe, out: recipe.out, count: recipe.count, to: pid });
    }
  }
}

function broadcastRoom(room, msg, exceptId) {
  const raw = JSON.stringify(msg);
  for (const [id, ws] of clients) {
    if (exceptId && id === exceptId) continue;
    if (ws.roomCode === room.code && ws.readyState === 1) ws.send(raw);
  }
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, game: "survival-embers", rooms: rooms.size, clients: clients.size }));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  const id = uid();
  ws.playerId = id;
  ws.roomCode = "";
  clients.set(id, ws);
  send(ws, { t: "welcome", id });

  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(String(buf));
    } catch {
      return;
    }
    const t = msg.t;
    try {
      if (t === "create") {
        const code = makeCode();
        const room = new Room(code, id);
        rooms.set(code, room);
        ws.roomCode = code;
        const sp = spawnPoints(room.seed, 1)[0];
        const name = String(msg.name || "幸存者").slice(0, 16);
        room.players.set(id, new Player(id, name, sp.x, sp.y, sp.z));
        send(ws, { t: "room", code, host: true, seed: room.seed });
        return;
      }
      if (t === "join") {
        const code = String(msg.code || "").toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          send(ws, { t: "err", m: "房间不存在" });
          return;
        }
        if (room.players.size >= MAX_PLAYERS) {
          send(ws, { t: "err", m: "房间已满" });
          return;
        }
        ws.roomCode = code;
        const sps = spawnPoints(room.seed, 8);
        const sp = sps[room.players.size % sps.length];
        const name = String(msg.name || "幸存者").slice(0, 16);
        room.players.set(id, new Player(id, name, sp.x, sp.y, sp.z));
        send(ws, { t: "room", code, host: room.hostId === id, seed: room.seed, started: room.started });
        broadcastRoom(room, { t: "sys", m: `${name} 加入了房间` }, id);
        return;
      }
      if (t === "start") {
        const room = rooms.get(ws.roomCode);
        if (!room || room.hostId !== id) return;
        room.start();
        broadcastRoom(room, { t: "start", seed: room.seed, resources: room.resources, spawns: spawnPoints(room.seed, 8) });
        return;
      }
      if (t === "input") {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const p = room.players.get(id);
        if (p) p.applyInput(msg);
        return;
      }
      if (t === "action") {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        room.handleAction(id, msg);
        return;
      }
    } catch (e) {
      console.error(e);
    }
  });

  ws.on("close", () => {
    const room = rooms.get(ws.roomCode);
    if (room) {
      room.players.delete(id);
      broadcastRoom(room, { t: "sys", m: "有人离开了房间" });
      if (room.players.size === 0) rooms.delete(ws.roomCode);
      else if (room.hostId === id) room.hostId = [...room.players.keys()][0];
    }
    clients.delete(id);
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.started) continue;
    room.tick(TICK_MS / 1000);
    broadcastRoom(room, room.snapshot());
  }
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`[survival-embers] listening on :${PORT}  ws path /ws`);
});

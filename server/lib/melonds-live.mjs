import { createConnection } from 'node:net';
import { closeSync, openSync, readSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { findEntry } from '../../shared/live/parse.mjs';
import { BW_EXP_START, BW_EXP_END, findBwExpGuard, isBwExpGuard } from '../../web/lib/bw-exp-cap.mjs';

const HEADER_ADDR = 0x027ffe00;
const HEADER_SIZE = 0x160;
const RAM_START = 0x02000000;
const RAM_END = 0x02400000;
const inRam = (addr, len) => addr >= RAM_START && addr + len <= RAM_END;
const checksum = (body) => (Buffer.from(body).reduce((sum, byte) => sum + byte, 0) & 0xff).toString(16).padStart(2, '0');

export function melonGame(path, table) {
  const header = Buffer.alloc(HEADER_SIZE);
  const fd = openSync(path, 'r');
  try {
    if (readSync(fd, header, 0, header.length, 0) !== header.length) return null;
  } finally {
    closeSync(fd);
  }
  const game = { platform: 'nds', title: header.toString('ascii', 0, 12).replace(/\0/g, ''), code: header.toString('ascii', 12, 16) };
  const entry = findEntry(table, game);
  if (entry?.platform !== 'nds' || (!entry.saveDataPtrAddr && !entry.partyAddr && !entry.partyPtrAddr)) return null;
  return { game, entry, header };
}

// Resume the ARM9 stub after the handshake so polling can run alongside the game.
class Arm9Client {
  constructor(port) {
    this.socket = createConnection({ host: '127.0.0.1', port });
    this.socket.setNoDelay(true);
    this.socket.setEncoding('ascii');
    this.buffer = '';
    this.socket.on('data', (data) => this.receive(data));
    this.socket.on('error', (error) => this.close(error));
    this.socket.on('close', () => this.close());
  }

  receive(data) {
    this.buffer = (this.buffer + data).replace(/^\++/, '');
    while (this.buffer.length) {
      if (this.buffer[0] !== '$' || this.buffer.length > 4096) return this.close();
      const end = this.buffer.indexOf('#');
      if (end < 0 || this.buffer.length < end + 3) return;
      const body = this.buffer.slice(1, end);
      if (checksum(body) !== this.buffer.slice(end + 1, end + 3).toLowerCase()) return this.close();
      this.buffer = this.buffer.slice(end + 3).replace(/^\++/, '');
      if (!this.noAck) this.socket.write('+');
      // Stop notifications can arrive independently of the request in flight.
      if (!/^[ST][0-9a-f]{2}/i.test(body)) this.pending?.resolve(body);
    }
  }

  send(body) {
    this.socket.write(`$${body}#${checksum(body)}`);
  }

  request(body) {
    if (this.socket.destroyed) return Promise.reject(new Error('melonDS ARM9 disconnected'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), 1500);
      this.pending = {
        resolve: (value) => { clearTimeout(timer); this.pending = null; resolve(value); },
        reject: (error) => { clearTimeout(timer); this.pending = null; reject(error); },
      };
      this.send(body);
    });
  }

  async start() {
    this.socket.write('+'); // melonDS waits for this byte before processing any packets.
    const caps = await this.request('qSupported:');
    if (!caps.split(';').includes('QStartNoAckMode+')) throw new Error('Incompatible melonDS ARM9 stub');
    this.noAck = true;
    if (await this.request('QStartNoAckMode') !== 'OK') throw new Error('Could not negotiate melonDS ARM9 mode');
    // melonDS 1.0 advertises vCont but rejects vCont;c. Plain c resumes without replying.
    if (await this.request('vCont;c') !== 'OK') {
      this.send('c');
      await delay(30); // Let the stub leave its stop loop before the first memory request.
    }
  }

  async read(addr, len) {
    const chunks = [];
    while (len > 0) {
      // melonDS 1.1 announces a 0x47f-byte packet, with two hex characters per byte.
      const size = Math.min(len, 512);
      const hex = await this.request(`m${addr.toString(16)},${size.toString(16)}`);
      if (hex.length !== size * 2 || !/^[0-9a-f]+$/i.test(hex)) throw new Error('Invalid melonDS RAM read');
      chunks.push(Buffer.from(hex, 'hex'));
      len -= size;
      addr += size;
    }
    return Buffer.concat(chunks);
  }

  async writeExpGuard(addr, cap) {
    if (await this.request(`M${addr.toString(16)},1:${cap.toString(16).padStart(2, '0')}`) !== 'OK') {
      throw new Error('Could not update the Black/White XP cap');
    }
  }

  close(error = new Error('melonDS ARM9 disconnected')) {
    this.pending?.reject(error);
    this.socket.destroy();
  }
}

/** Collect the small regions consumed by the shared party and badge parser. */
async function snapshot(client, { entry }) {
  const regions = [];
  const read = async (addr, len) => {
    if (!inRam(addr, len)) return null;
    const bytes = await client.read(addr, len);
    regions.push({ addr, hex: bytes.toString('hex') });
    return bytes;
  };
  let core;
  let inBattle = false;
  if (entry.inBattle?.verified && !entry.scanOnly) {
    const flag = await read(Number(entry.inBattle.addr), 2);
    inBattle = !!flag && entry.inBattle.inBattleValues?.some((value) => Number(value) === flag.readUInt16LE());
  }
  if (entry.gen === 4) {
    const moduleAddr = /^(diamond|pearl)/.test(entry.id) ? 0x02000b70 : 0x02000ba8;
    const module = (await read(moduleAddr, 4)).readUInt32LE();
    const fixed = Number(entry.saveDataPtrAddr);
    const dynamic = inRam(module, 4) && (!fixed || Math.abs(module + 0x20 - fixed) < 0x40000);
    const base = (await read(dynamic ? module + 0x20 : fixed, 4))?.readUInt32LE();
    if (!inRam(base, 4)) return { status: 'party' };
    core = base + Number(entry.partyMonsOffset) - 8;
    if (entry.badges?.trainerOffset) {
      await read(base + Number(entry.badges.generalOffsetFromSaveBase) + Number(entry.badges.trainerOffset), 0x20);
    }
  } else {
    core = Number(entry.partyAddr) - 8;
    if (entry.partyPtrAddr) {
      const ptr = (await read(Number(entry.partyPtrAddr), 4)).readUInt32LE();
      core = RAM_START + (ptr & 0xffffff) + Number(entry.partyMonsOffsetFromPtr) - 8;
    }
    await read(core + 0x614, 4); // trainer ID and secret ID
    await read(core + (/^(black2|white2)_/.test(entry.id) ? 0x8300 : 0x8400), 5);
  }
  const party = await read(core, 8 + 6 * (entry.gen === 4 ? 236 : 220));
  return party?.readUInt32LE(0) === 6 && party.readUInt32LE(4) >= 1 && party.readUInt32LE(4) <= 6
    ? { status: 'live', regions, inBattle }
    : { status: 'party' };
}

export function watchMelonDs({ port, runId, slot, rom, emit, getCap = () => 100 }) {
  let stopped = false;
  let status;
  let client;
  let timer;
  let pending;
  let guard;
  let previous = 100;
  const supportsCap = /^IR[AB]O$/.test(rom.game.code);
  const matchesRom = (connection) => connection.read(HEADER_ADDR, HEADER_SIZE).then((header) => header.equals(rom.header));
  const locateExpGuard = async (connection, offset, length) => {
    const start = RAM_START + offset;
    const bytes = await connection.read(start, length);
    const site = findBwExpGuard(bytes, offset);
    return site ? { addr: start + site, stock: bytes.subarray(site, site + 6) } : null;
  };
  const applyCap = async (connection, cap, inBattle) => {
    if (guard) {
      const code = await connection.read(guard.addr, 6);
      if (isBwExpGuard(code, previous) && code.subarray(1).equals(guard.stock.subarray(1))) {
        if (code[0] !== cap) await connection.writeExpGuard(guard.addr, cap);
        previous = cap;
        return cap < 100;
      }
      guard = null;
    }
    if (cap === 100 || !inBattle || stopped) return false;
    // The retail routine starts around 0x021d69b8; try its block first to avoid delaying a battle snapshot.
    const found = await locateExpGuard(connection, 0x1d6900, 0x400) ??
      await locateExpGuard(connection, BW_EXP_START, BW_EXP_END - BW_EXP_START);
    if (!found || stopped) return false;
    const { addr, stock } = found;
    const code = await connection.read(addr, 6);
    if (!isBwExpGuard(code, 100) || !code.equals(stock) || !await matchesRom(connection) || stopped) return false;
    guard = found;
    previous = cap;
    await connection.writeExpGuard(addr, cap);
    return true;
  };
  const announce = (frame) => {
    if (!frame.regions && frame.status === status) return;
    status = frame.status;
    emit('live', { emulator: 'melonds', runId, slot, game: rom.game, regions: [], inBattle: false, ...frame });
  };
  const schedule = (delay) => {
    timer = setTimeout(() => { pending = poll(); }, delay).unref();
  };
  const poll = async () => {
    let delay = 250;
    try {
      if (!client) {
        client = new Arm9Client(port);
        await client.start();
      }
      const frame = await matchesRom(client) ? await snapshot(client, rom) : { status: 'rom' };
      if (!stopped && supportsCap && frame.status !== 'rom') {
        try {
          frame.capActive = await applyCap(client, getCap(), frame.inBattle);
        } catch {
          frame.capActive = false;
        }
      }
      if (!stopped) announce(frame);
    } catch {
      client?.close();
      client = null;
      if (!stopped) announce({ status: 'connection' });
      delay = 1500;
    } finally {
      if (!stopped) schedule(delay);
    }
  };
  schedule(0);
  return async () => {
    stopped = true;
    clearTimeout(timer);
    if (!guard) client?.close();
    await pending;
    try {
      if (client && guard && previous < 100 && await matchesRom(client)) await applyCap(client, 100, false);
    } catch {
      // The game may already have closed or unloaded the overlay.
    } finally {
      client?.close();
      announce({ status: 'off' });
    }
  };
}

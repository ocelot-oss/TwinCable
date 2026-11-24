import { createConnection } from 'node:net';
import { closeSync, openSync, readSync } from 'node:fs';
import { findEntry } from '../../shared/live/parse.mjs';

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
  if (entry?.platform !== 'nds' || (entry.gen !== 4 && !entry.partyAddr && !entry.partyPtrAddr)) return null;
  return { game, entry, header };
}

// The ARM9 stub stops on attach. Resume after the handshake, then use only memory reads.
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
      this.pending?.resolve(body);
    }
  }

  send(body) {
    this.socket.write(`$${body}#${checksum(body)}`);
  }

  request(body) {
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
    if (await this.request('QStartNoAckMode') !== 'OK' || await this.request('vCont;c') !== 'OK') {
      throw new Error('Could not resume melonDS');
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

  close(error = new Error('melonDS ARM9 disconnected')) {
    this.pending?.reject(error);
    this.socket.destroy();
  }
}

/** Collect the small regions consumed by the shared party and badge parser. */
async function snapshot(client, { entry, header }) {
  if (!(await client.read(HEADER_ADDR, HEADER_SIZE)).equals(header)) return null;
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
    if (!inRam(base, 4)) return null;
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
  return party?.readUInt32LE(4) >= 1 && party.readUInt32LE(4) <= 6 ? { regions, inBattle: !!inBattle } : null;
}

export function watchMelonDs({ port, runId, slot, rom, emit }) {
  let stopped = false;
  let streaming = false;
  let client;
  let timer;
  const announce = (frame) => {
    if (!frame && !streaming) return;
    streaming = !!frame;
    emit('live', { emulator: 'melonds', runId, slot, game: rom.game, ...(frame || { regions: [], inBattle: false }) });
  };
  const poll = async () => {
    let delay = 250;
    try {
      if (!client) {
        client = new Arm9Client(port);
        await client.start();
      }
      const frame = await snapshot(client, rom);
      if (!stopped) announce(frame);
    } catch {
      client?.close();
      client = null;
      if (!stopped) announce(null);
      delay = 1500;
    } finally {
      if (!stopped) timer = setTimeout(poll, delay).unref();
    }
  };
  timer = setTimeout(poll, 0).unref();
  return () => {
    stopped = true;
    clearTimeout(timer);
    client?.close();
    announce(null);
  };
}

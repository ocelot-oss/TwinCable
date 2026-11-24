import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';
import { watchMelonDs } from '../server/lib/melonds-live.mjs';
import { encryptPK4 } from '../shared/gen4save.mjs';
import { findEntry, LiveTables, readLiveParty, regionReader } from '../shared/live/parse.mjs';

const data = (file) => JSON.parse(readFileSync(new URL(`../shared/data/${file}.json`, import.meta.url)));
const gen4 = new LiveTables({ gen4: data('gen4') });
const game = { platform: 'nds', code: 'IRBO', title: 'POKEMON BLACK' };
const battleFlagAddr = 0x02000040;
const entry = { ...findEntry(data('addresses'), game), inBattle: { addr: battleFlagAddr, verified: true, inBattleValues: [0x2100] } };
const core = Number(entry.partyAddr) - 8;
const packet = (text) => `$${text}#${(Buffer.from(text).reduce((sum, byte) => sum + byte, 0) & 255).toString(16).padStart(2, '0')}`;

async function stub(t, slot, hp) {
  const header = Buffer.alloc(0x160);
  header.write(game.code, 12);
  header[0x15e] = Number(slot.slice(1));
  const party = Buffer.alloc(8 + 6 * 220);
  const battle = Buffer.alloc(2);
  party.writeUInt32LE(6, 0);
  party.writeUInt32LE(1, 4);
  const setHP = (value) => {
    const mon = Buffer.alloc(220);
    mon.writeUInt32LE(0xabcdef01, 0);
    mon.writeUInt16LE(495, 0x08);
    mon[0x8c] = 9;
    mon.writeUInt16LE(value, 0x8e);
    mon.writeUInt16LE(40, 0x90);
    party.set(encryptPK4(new Uint8Array(mon)), 8);
  };
  setHP(hp);
  const server = createServer((socket) => {
    let buffer = '';
    let attached = false;
    let running = false;
    t.after(() => socket.destroy());
    socket.setEncoding('ascii');
    socket.on('data', (data) => {
      if (!attached) {
        assert.equal(data[0], '+');
        attached = true;
        data = data.slice(1);
      }
      buffer += data;
      for (const match of buffer.matchAll(/\$([^#]*)#[0-9a-f]{2}/g)) {
        const cmd = match[1];
        let response;
        if (cmd === 'qSupported:') response = '+'.concat(packet('PacketSize=47F;QStartNoAckMode+'));
        else if (cmd === 'QStartNoAckMode') response = '+'.concat(packet('OK'));
        else if (cmd === 'vCont;c') {
          running = true;
          response = packet('OK');
        }
        else {
          assert.equal(running, true);
          const [, addr, len] = /^m([0-9a-f]+),([0-9a-f]+)$/.exec(cmd);
          const start = parseInt(addr, 16);
          const size = parseInt(len, 16);
          assert.ok(size <= 512);
          let bytes = Buffer.alloc(size);
          if (start === 0x027ffe00) bytes = header;
          else if (start === battleFlagAddr) bytes = battle;
          else if (start >= core && start < core + party.length) bytes = party.subarray(start - core, start - core + size);
          response = packet(bytes.toString('hex'));
        }
        if (response) {
          socket.write(response.slice(0, 2));
          socket.write(response.slice(2));
        }
      }
      buffer = buffer.replace(/^\+*(?:\$[^#]*#[0-9a-f]{2}\+*)*/g, '');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); });
  return { header, port: server.address().port, setHP, setBattle: (on) => battle.writeUInt16LE(on ? 0x2100 : 0) };
}

test('two melonDS feeds stay assigned to their slots and report HP changes without a save', { timeout: 5000 }, async (t) => {
  const [one, two] = await Promise.all([stub(t, 'p1', 34), stub(t, 'p2', 21)]);
  const values = {};
  let battleSeen = false;
  const seen = new Promise((resolve, reject) => {
    for (const [slot, source] of [['p1', one], ['p2', two]]) {
      t.after(watchMelonDs({
        port: source.port, runId: 'aaaaaaaa', slot, rom: { header: source.header, game, entry },
        emit(event, frame) {
          try {
            assert.equal(event, 'live');
            assert.equal(frame.runId, 'aaaaaaaa');
            assert.equal(frame.slot, slot);
            if (!frame.regions.length) return;
            const result = readLiveParty(entry, regionReader(frame.regions), gen4);
            assert.ok(result?.party);
            values[slot] = result.party[0].hp;
            if (slot === 'p2') assert.equal(frame.inBattle, false);
            if (values.p1 === 34 && values.p2 === 21) {
              one.setHP(12);
              one.setBattle(true);
            }
            if (slot === 'p1' && frame.inBattle) {
              battleSeen = true;
              one.setBattle(false);
            } else if (slot === 'p1' && battleSeen && values.p1 === 12 && values.p2 === 21) {
              resolve();
            }
          } catch (error) {
            reject(error);
          }
        },
      }));
    }
  });
  // Pollers are unref'd in production. The TCP servers keep this test alive.
  await seen;
});

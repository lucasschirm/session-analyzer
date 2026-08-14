import fs from 'node:fs';
import init from '@sqlite.org/sqlite-wasm';

for (const path of ['/tmp/opfs-after-create.sqlite', '/tmp/opfs-after-reload.sqlite']) {
  const bytes = new Uint8Array(fs.readFileSync(path));
  const sqlite3 = await init();
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  const capi = sqlite3.capi;
  const wasm = sqlite3.wasm;
  const n = bytes.byteLength;
  const pMem = wasm.allocFromTypedArray(bytes);
  capi.sqlite3_deserialize(
    db.pointer,
    'main',
    pMem,
    n,
    n,
    capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
  );
  const tables = db.selectValues("SELECT name FROM sqlite_master WHERE type='table'");
  console.log(path, '-> tables:', JSON.stringify(tables));
  try {
    console.log(
      path,
      '-> projects rows:',
      JSON.stringify(db.selectObjects('SELECT * FROM projects')),
    );
  } catch (e) {
    console.log(path, '-> query error:', e.message);
  }
  db.close();
}

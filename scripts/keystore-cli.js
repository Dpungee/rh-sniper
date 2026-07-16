// Import or unlock a key from the terminal (alternative to the UI import screen).
//   node scripts/keystore-cli.js import
//   node scripts/keystore-cli.js check
import readline from 'node:readline';
import { saveKey, keystoreExists, savedAddress } from '../src/engine/keystore.js';

function ask(q, hidden=false){
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res=>{
    if (hidden){ rl.stdoutMuted = true; rl._writeToOutput = ()=>{}; }
    rl.question(q, a=>{ rl.close(); if(hidden) process.stdout.write('\n'); res(a); });
  });
}

const cmd = process.argv[2] || 'check';
if (cmd === 'check'){
  console.log(keystoreExists() ? `Keystore present for ${savedAddress()}` : 'No keystore yet.');
  process.exit(0);
}
if (cmd === 'import'){
  const pk = await ask('Private key (0x...): ', true);
  const pw = await ask('Password: ', true);
  const addr = saveKey(pk, pw);
  console.log(`Saved encrypted keystore for ${addr}`);
  process.exit(0);
}
console.log('Usage: node scripts/keystore-cli.js [import|check]');

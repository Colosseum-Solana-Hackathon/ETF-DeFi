const {PublicKey} = require('@solana/web3.js');

const ARCIUM = new PublicKey('BKck65TgoKRokMjQM3datB9oRwJ8rAj2jxPXvHXUvcL6');
const PROGRAM = new PublicKey('6sQTw22nEhpV8byHif5M6zTJXSG1Gp8qtsTY4qfdq65K');
const MXE = new PublicKey('FFtGZYfUXf2roU7JKpjPux5P5kVjfy6RbvVV1SrNMpVE');
const TARGET = new PublicKey('DE8sAVgkKkGpMDY85WQtib8yymJv1B2qdzQzWRsYENhX');

console.log('Target address:', TARGET.toString());
console.log('\nTrying different seed combinations:\n');

const tests = [
  ['comp_def', PROGRAM.toBuffer()],
  ['comp_def', MXE.toBuffer()],
  ['computation_definition', PROGRAM.toBuffer()],
  ['computation_definition', MXE.toBuffer()],
];

// Also try with different offsets
for (let i = 0; i < 10; i++) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(i);
  tests.push(['comp_def', buf]);
}

// Try hashing variations
const crypto = require('crypto');
const names = ['compute_rebalancing', 'rebalancing', 'ComputeRebalancing'];
names.forEach(name => {
  const hash = crypto.createHash('sha256').update(name).digest();
  const offset = hash.readUInt32LE(0);
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(offset);
  tests.push([`comp_def [${name}]`, buf]);
});

tests.forEach(seeds => {
  try {
    const seedLabel = seeds[0].toString();
    const seedData = seeds[1];
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from('comp_def'), seedData], ARCIUM);
    const match = pda.equals(TARGET) ? '✅ MATCH!' : '';
    console.log(`${seedLabel.padEnd(40)} -> ${pda.toString()} ${match}`);
  } catch(e){}
});

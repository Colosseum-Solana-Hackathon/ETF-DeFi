const { Connection, PublicKey } = require('@solana/web3.js');

(async () => {
  const conn = new Connection('https://api.devnet.solana.com');
  const mxe = new PublicKey('FFtGZYfUXf2roU7JKpjPux5P5kVjfy6RbvVV1SrNMpVE');
  const info = await conn.getAccountInfo(mxe);
  
  console.log('MXE Account Data:');
  console.log('  Total size:', info.data.length, 'bytes');
  console.log('  First 100 bytes (hex):', info.data.slice(0, 100).toString('hex'));
  
  // MXE account structure (typical):
  // 0-8: discriminator
  // 8-40: authority (32 bytes)
  // Read authority
  try {
    const authorityBytes = info.data.slice(8, 40);
    const authority = new PublicKey(authorityBytes);
    console.log('\n✅ MXE Authority:', authority.toString());
  } catch (e) {
    console.log('\n❌ Could not parse authority:', e.message);
  }
})();

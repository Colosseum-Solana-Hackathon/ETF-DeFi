import { Connection, PublicKey } from "@solana/web3.js";

/**
 * Script to fetch and display Marinade account addresses
 * Run with: ts-node scripts/fetch-marinade-accounts.ts
 */

const MARINADE_PROGRAM_ID = new PublicKey("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");
const MARINADE_STATE = new PublicKey("8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC");
const MSOL_MINT = new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");

async function main() {
  // Connect to devnet (change to mainnet if needed)
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");

  console.log("=" .repeat(80));
  console.log("MARINADE FINANCE ACCOUNT ADDRESSES");
  console.log("=".repeat(80));
  console.log();

  console.log("📍 Core Addresses:");
  console.log(`  Marinade Program ID: ${MARINADE_PROGRAM_ID.toString()}`);
  console.log(`  Marinade State:      ${MARINADE_STATE.toString()}`);
  console.log(`  mSOL Mint:           ${MSOL_MINT.toString()}`);
  console.log();

  // Derive PDAs
  console.log("🔑 Derived PDAs:");
  
  const [reservePda] = PublicKey.findProgramAddressSync(
    [MARINADE_STATE.toBuffer(), Buffer.from("reserve")],
    MARINADE_PROGRAM_ID
  );
  console.log(`  Reserve PDA:         ${reservePda.toString()}`);

  const [msolMintAuthority] = PublicKey.findProgramAddressSync(
    [MARINADE_STATE.toBuffer(), Buffer.from("st_mint")],
    MARINADE_PROGRAM_ID
  );
  console.log(`  mSOL Mint Authority: ${msolMintAuthority.toString()}`);

  const [liqPoolSolLegPda] = PublicKey.findProgramAddressSync(
    [MARINADE_STATE.toBuffer(), Buffer.from("liq_sol")],
    MARINADE_PROGRAM_ID
  );
  console.log(`  Liq Pool SOL Leg:    ${liqPoolSolLegPda.toString()}`);

  const [liqPoolMsolLegAuthority] = PublicKey.findProgramAddressSync(
    [MARINADE_STATE.toBuffer(), Buffer.from("liq_st_authority")],
    MARINADE_PROGRAM_ID
  );
  console.log(`  Liq Pool mSOL Auth:  ${liqPoolMsolLegAuthority.toString()}`);
  console.log();

  // Fetch from state (this requires parsing the Marinade state account)
  console.log("📊 Fetching from Marinade State...");
  try {
    const accountInfo = await connection.getAccountInfo(MARINADE_STATE);
    
    if (accountInfo) {
      console.log(`  State Account Size:  ${accountInfo.data.length} bytes`);
      console.log(`  Owner:               ${accountInfo.owner.toString()}`);
      
      // Known addresses from Marinade (these are static on mainnet/devnet)
      const knownAccounts = {
        liqPoolMsolLeg: "7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE",
        treasuryMsolAccount: "B1aLzaNMeFVAyQ6f3XbbUyKcH2YPHu2fqiEagmiF23VR",
      };
      
      console.log();
      console.log("💎 Known Token Accounts:");
      console.log(`  Liq Pool mSOL Leg:   ${knownAccounts.liqPoolMsolLeg}`);
      console.log(`  Treasury mSOL:       ${knownAccounts.treasuryMsolAccount}`);
    } else {
      console.log("  ⚠️  Marinade state not found on this network");
    }
  } catch (error) {
    console.error("  Error fetching state:", error);
  }

  console.log();
  console.log("=".repeat(80));
  console.log("💡 TIP: Copy these addresses into your test file for easy reference");
  console.log("=".repeat(80));
  console.log();

  // Generate TypeScript code snippet
  console.log("📝 TypeScript Code Snippet:");
  console.log();
  console.log("```typescript");
  console.log(`const MARINADE_PROGRAM_ID = new PublicKey("${MARINADE_PROGRAM_ID.toString()}");`);
  console.log(`const MARINADE_STATE = new PublicKey("${MARINADE_STATE.toString()}");`);
  console.log(`const MSOL_MINT = new PublicKey("${MSOL_MINT.toString()}");`);
  console.log();
  console.log("// Derived PDAs");
  console.log(`const reservePda = new PublicKey("${reservePda.toString()}");`);
  console.log(`const msolMintAuthority = new PublicKey("${msolMintAuthority.toString()}");`);
  console.log(`const liqPoolSolLegPda = new PublicKey("${liqPoolSolLegPda.toString()}");`);
  console.log(`const liqPoolMsolLegAuthority = new PublicKey("${liqPoolMsolLegAuthority.toString()}");`);
  console.log();
  console.log("// Token Accounts");
  console.log(`const liqPoolMsolLeg = new PublicKey("7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE");`);
  console.log(`const treasuryMsolAccount = new PublicKey("B1aLzaNMeFVAyQ6f3XbbUyKcH2YPHu2fqiEagmiF23VR");`);
  console.log("```");
  console.log();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

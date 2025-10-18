import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Initialize Mock Oracle for Devnet Testing
 * 
 * This script creates the on-chain mock oracle account that will store
 * real-time BTC, ETH, and SOL prices fetched from CoinGecko.
 */
async function main() {
  console.log("\n" + "=".repeat(80));
  console.log("🎭 INITIALIZING MOCK ORACLE");
  console.log("=".repeat(80) + "\n");

  // Setup Anchor
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Vault as Program<Vault>;
  const provider = program.provider as anchor.AnchorProvider;

  // Load admin keypair
  const keypairPath = path.join(os.homedir(), ".config", "solana", "id.json");
  if (!fs.existsSync(keypairPath)) {
    console.error("❌ Admin keypair not found at:", keypairPath);
    console.error("   Please run: solana-keygen new");
    process.exit(1);
  }

  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")));
  const admin = Keypair.fromSecretKey(secretKey);

  console.log("📊 Configuration:");
  console.log("  Program ID:", program.programId.toString());
  console.log("  Admin:", admin.publicKey.toString());
  console.log("  RPC:", provider.connection.rpcEndpoint);

  // Derive mock oracle PDA
  const [mockOracle, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("mock_oracle"), admin.publicKey.toBuffer()],
    program.programId
  );

  console.log("\n📍 Mock Oracle PDA:");
  console.log("  Address:", mockOracle.toString());
  console.log("  Bump:", bump);

  // Check if oracle already exists
  try {
    const existingOracle = await program.account.mockPriceOracle.fetch(mockOracle);
    console.log("\n⚠️  Mock oracle already exists!");
    console.log("  Authority:", existingOracle.authority.toString());
    console.log("  BTC Price: $" + (existingOracle.btcPrice.toNumber() / 1_000_000).toFixed(2));
    console.log("  ETH Price: $" + (existingOracle.ethPrice.toNumber() / 1_000_000).toFixed(2));
    console.log("  SOL Price: $" + (existingOracle.solPrice.toNumber() / 1_000_000).toFixed(2));
    console.log("  Last Update:", new Date(existingOracle.lastUpdate.toNumber() * 1000).toISOString());
    console.log("\nℹ️  No action needed. Oracle is ready to use.");
    console.log("\n💡 Next steps:");
    console.log("  • Run: yarn update-prices (to start price updates)");
    console.log("  • Run: yarn test:oracle-full (to test integration)");
    console.log("\n" + "=".repeat(80) + "\n");
    return;
  } catch (error: any) {
    if (!error.toString().includes("Account does not exist")) {
      console.error("\n❌ Error checking oracle:", error);
      process.exit(1);
    }
    // Oracle doesn't exist, continue with initialization
  }

  // Check admin balance
  const balance = await provider.connection.getBalance(admin.publicKey);
  const solBalance = balance / anchor.web3.LAMPORTS_PER_SOL;
  console.log("\n💰 Admin Balance:", solBalance.toFixed(4), "SOL");
  
  if (solBalance < 0.5) {
    console.warn("⚠️  Low balance! You may need more SOL for initialization.");
    console.log("   Run: solana airdrop 2 --url devnet");
  }

  // Initialize oracle
  console.log("\n🔨 Initializing mock oracle...");
  
  try {
    const tx = await program.methods
      .initializeMockOracle()
      .accounts({
        authority: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    console.log("✅ Transaction successful!");
    console.log("  Signature:", tx);

    // Verify creation
    const oracleAccount = await program.account.mockPriceOracle.fetch(mockOracle);
    
    console.log("\n📋 Oracle Details:");
    console.log("  Address:", mockOracle.toString());
    console.log("  Authority:", oracleAccount.authority.toString());
    console.log("  BTC Price:", oracleAccount.btcPrice.toNumber(), "(initialized to 0)");
    console.log("  ETH Price:", oracleAccount.ethPrice.toNumber(), "(initialized to 0)");
    console.log("  SOL Price:", oracleAccount.solPrice.toNumber(), "(initialized to 0)");
    console.log("  Last Update:", new Date(oracleAccount.lastUpdate.toNumber() * 1000).toISOString());
    console.log("  Bump:", oracleAccount.bump);

    console.log("\n✅ Mock oracle initialized successfully!");
    console.log("\n💡 Next steps:");
    console.log("  1. Run: yarn update-prices");
    console.log("     This will fetch real-time prices from CoinGecko and update the oracle");
    console.log("\n  2. Run: yarn test:oracle-full");
    console.log("     This will test deposit/withdraw operations with real-time prices");
    console.log("\n  3. Configure your vault to use the mock oracle:");
    console.log("     await program.methods.setPriceSource(vaultName, { mockOracle: {} }, mockOracle)");

  } catch (error: any) {
    console.error("\n❌ Failed to initialize oracle:", error);
    
    if (error.toString().includes("already in use")) {
      console.log("\nℹ️  The oracle account already exists.");
      console.log("   This is normal if you've run this script before.");
    } else if (error.toString().includes("insufficient funds")) {
      console.log("\n💰 Insufficient funds for initialization.");
      console.log("   Run: solana airdrop 2 --url devnet");
    } else {
      console.log("\n📝 Error details:", error.message || error);
    }
    
    process.exit(1);
  }

  console.log("\n" + "=".repeat(80) + "\n");
}

main().catch((error) => {
  console.error("\n❌ Fatal error:", error);
  process.exit(1);
});

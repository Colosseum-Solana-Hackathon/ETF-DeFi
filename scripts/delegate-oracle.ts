import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Delegate Mock Oracle to Ephemeral Rollup
 * 
 * This script delegates the MockOracle PDA to MagicBlock's Ephemeral Rollup
 * for high-frequency price updates without L1 transaction fees.
 * 
 * After delegation:
 * - Oracle can be updated every 100-500ms on ER (vs 30s on L1)
 * - Updates are FREE (no transaction fees while on ER)
 * - State commits to L1 automatically every 30 seconds
 * 
 * Usage:
 *   yarn delegate-oracle
 */

async function main() {
  console.log("\n" + "=".repeat(80));
  console.log("📤 DELEGATING MOCK ORACLE TO EPHEMERAL ROLLUP");
  console.log("=".repeat(80) + "\n");

  // Setup Anchor with L1 provider
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
  console.log("  L1 RPC:", provider.connection.rpcEndpoint);
  console.log("  ER RPC: https://devnet.magicblock.app/");

  // Derive mock oracle PDA
  const [mockOracle, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("mock_oracle"), admin.publicKey.toBuffer()],
    program.programId
  );

  console.log("\n📍 Mock Oracle PDA:");
  console.log("  Address:", mockOracle.toString());
  console.log("  Bump:", bump);

  // Verify oracle exists on L1
  try {
    const oracleData: any = await (program.account as any).mockPriceOracle.fetch(mockOracle);
    console.log("\n✅ Oracle found on L1:");
    console.log("  Authority:", oracleData.authority.toString());
    console.log("  BTC: $" + (oracleData.btcPrice.toNumber() / 1_000_000).toFixed(2));
    console.log("  ETH: $" + (oracleData.ethPrice.toNumber() / 1_000_000).toFixed(2));
    console.log("  SOL: $" + (oracleData.solPrice.toNumber() / 1_000_000).toFixed(2));
    console.log("  Last Update:", new Date(oracleData.lastUpdate.toNumber() * 1000).toISOString());

    if (!oracleData.authority.equals(admin.publicKey)) {
      console.error("\n❌ Authority mismatch! You don't have permission to delegate this oracle.");
      process.exit(1);
    }
  } catch (error) {
    console.error("\n❌ Oracle not found on L1:", mockOracle.toString());
    console.error("   Please run: yarn initialize-mock-oracle");
    process.exit(1);
  }

  // Check admin balance
  const balance = await provider.connection.getBalance(admin.publicKey);
  const solBalance = balance / anchor.web3.LAMPORTS_PER_SOL;
  console.log("\n💰 Admin Balance:", solBalance.toFixed(4), "SOL");

  if (solBalance < 0.1) {
    console.warn("⚠️  Low balance! You may need more SOL for delegation.");
    console.log("   Run: solana airdrop 2 --url devnet");
  }

  // Delegate oracle to ER
  console.log("\n🚀 Delegating oracle to Ephemeral Rollup...");
  console.log("   This will enable high-frequency price updates (100-500ms)");
  console.log("   Updates will be FREE while on ER");
  console.log("   State will commit to L1 every 30 seconds");

  try {
    const tx = await program.methods
      .delegateMockOracle()
      .accounts({
        authority: admin.publicKey,
        mockOracle: mockOracle,
      })
      .signers([admin])
      .rpc({ commitment: "confirmed" });

    console.log("\n✅ Delegation successful!");
    console.log("  Transaction:", tx);
    console.log("  Explorer: https://explorer.solana.com/tx/" + tx + "?cluster=devnet");

    // Wait a moment for delegation to propagate
    console.log("\n⏳ Waiting for delegation to propagate to ER...");
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log("\n🎉 Oracle successfully delegated to Ephemeral Rollup!");
    console.log("\n💡 Next steps:");
    console.log("  1. Run: yarn update-prices-er");
    console.log("     This will start high-frequency price updates (100ms intervals)");
    console.log("\n  2. Monitor oracle state on ER:");
    console.log("     Oracle: " + mockOracle.toString());
    console.log("     ER Endpoint: https://devnet.magicblock.app/");
    console.log("\n  3. When done, undelegate back to L1:");
    console.log("     Run: yarn undelegate-oracle");

  } catch (error: any) {
    console.error("\n❌ Delegation failed:", error);

    if (error.toString().includes("already delegated")) {
      console.log("\n⚠️  Oracle is already delegated to ER!");
      console.log("   You can start updating prices: yarn update-prices-er");
      console.log("   Or undelegate first: yarn undelegate-oracle");
    } else if (error.toString().includes("insufficient funds")) {
      console.log("\n💰 Insufficient funds for delegation.");
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

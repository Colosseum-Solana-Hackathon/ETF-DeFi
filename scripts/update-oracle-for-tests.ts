import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

/**
 * Quick script to update oracle prices before running tests
 */

async function main() {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Vault as Program<Vault>;
  
  // Load admin keypair
  const adminKeypairPath = path.join(process.cwd(), "admin-keypair.json");
  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(adminKeypairPath, "utf-8")));
  const admin = Keypair.fromSecretKey(secretKey);
  
  // Derive mock oracle PDA
  const [mockOracle] = PublicKey.findProgramAddressSync(
    [Buffer.from("mock_oracle"), admin.publicKey.toBuffer()],
    program.programId
  );
  
  console.log("Updating oracle prices for testing...");
  console.log("Oracle:", mockOracle.toString());
  
  // Set reasonable test prices
  const prices = {
    btc: new anchor.BN(50_000 * 1_000_000), // $50,000
    eth: new anchor.BN(3_000 * 1_000_000),  // $3,000
    sol: new anchor.BN(100 * 1_000_000),    // $100
  };
  
  await (program.methods as any)
    .updateMockOracle(prices.btc, prices.eth, prices.sol)
    .accounts({
      mockOracle,
      authority: admin.publicKey,
    })
    .signers([admin])
    .rpc();
  
  console.log("✅ Oracle prices updated:");
  console.log("  BTC: $50,000");
  console.log("  ETH: $3,000");
  console.log("  SOL: $100");
  
  // Verify
  const oracleData: any = await (program.account as any).mockPriceOracle.fetch(mockOracle);
  const age = Math.floor(Date.now() / 1000) - Number(oracleData.lastUpdate);
  console.log(`  Age: ${age} seconds (fresh!)\n`);
}

main().catch(console.error);


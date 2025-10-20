import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Configure an existing deployed vault to use MockOracle on devnet and seed prices.
 * Reads vault info from etf-vault-deployment.json.
 */
async function main() {
  // Build provider with fallback to devnet if ANCHOR_PROVIDER_URL is not set
  const rpcUrl = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";

  // Load admin keypair first (used for wallet)
  const keypairPath = path.join(os.homedir(), ".config", "solana", "id.json");
  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")));
  const admin = Keypair.fromSecretKey(secretKey);

  const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  anchor.setProvider(provider);

  const program = anchor.workspace.Vault as Program<Vault>;

  console.log("Configuring existing vault to use MockOracle on:", provider.connection.rpcEndpoint);

  console.log("Admin:", admin.publicKey.toString());

  // Load deployment info
  const deploymentPath = path.join(__dirname, "..", "etf-vault-deployment.json");
  if (!fs.existsSync(deploymentPath)) {
    throw new Error("etf-vault-deployment.json not found. Run deployment first.");
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));

  const vaultName: string = deployment.vaultName;
  const vaultPda = new PublicKey(deployment.vaultPda);
  console.log("Vault:", vaultName, vaultPda.toString());

  // Derive Mock Oracle PDA
  const [mockOracle] = PublicKey.findProgramAddressSync(
    [Buffer.from("mock_oracle"), admin.publicKey.toBuffer()],
    program.programId
  );

  // Initialize mock oracle if needed
  try {
    await (program.methods as any)
      .initializeMockOracle()
      .accounts({
        mockOracle,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
    console.log("✅ Mock Oracle initialized:", mockOracle.toString());
  } catch (e) {
    console.log("ℹ️  Mock Oracle may already exist:", mockOracle.toString());
  }

  // Seed prices (micro-USD)
  const btcPrice = new anchor.BN(110_000 * 1_000_000);
  const ethPrice = new anchor.BN(4_000 * 1_000_000);
  const solPrice = new anchor.BN(190 * 1_000_000);

  await (program.methods as any)
    .updateMockOracle(btcPrice, ethPrice, solPrice)
    .accounts({ mockOracle, authority: admin.publicKey })
    .signers([admin])
    .rpc();
  console.log("✅ Mock Oracle prices updated");

  await (program.methods as any)
    .setPriceSource(vaultName, { mockOracle: {} }, mockOracle)
    .accounts({ vault: vaultPda, authority: admin.publicKey })
    .signers([admin])
    .rpc();
  console.log("✅ Vault price source set to MockOracle");

  // Persist oracle address and priceSource in deployment json
  const updated = { ...deployment, mockOracle: mockOracle.toString(), priceSource: "MockOracle" };
  fs.writeFileSync(deploymentPath, JSON.stringify(updated, null, 2));
  console.log("💾 Updated:", deploymentPath);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });



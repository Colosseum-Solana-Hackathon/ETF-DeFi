// scripts/init-vault.ts
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { MarinadeStrategy } from "../target/types/marinade_strategy";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";

// Configuration matching your constants
const VAULT_NAME = "SOL-BTC-ETH-Index";
const VAULT_ADMIN_KEYPAIR_PATH = "~/.config/solana/id.json"; // Your admin wallet

const BTC_MINT = new PublicKey("CqcPvtoEthDVBKv8bDtGYEoDLjNCDyA41AQPRb3L8pxA");
const ETH_MINT = new PublicKey("66yFx2ySRRNxyhPRybdgzyWvFg3sVU6Erb7UhBgU2NS1");
const SOL_MINT = new PublicKey("DBLEUSQtyVuNsyTR7qGt1iJ1D4Mx2woMTiEVejWFfxSQ");

const MARINADE_PROGRAM_ID = new PublicKey("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");
const MARINADE_STATE = new PublicKey("8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC");
const MSOL_MINT = new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");

async function initializeVault() {
  // Set up provider
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Vault as Program<Vault>;
  const marinadeProgram = anchor.workspace.MarinadeStrategy as Program<MarinadeStrategy>;

  // Load admin keypair
  const adminKeypair = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(VAULT_ADMIN_KEYPAIR_PATH.replace("~", process.env.HOME), "utf-8")))
  );

  console.log("Admin:", adminKeypair.publicKey.toString());

  // Derive PDAs
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), adminKeypair.publicKey.toBuffer(), Buffer.from(VAULT_NAME)],
    program.programId
  );

  const [vaultTokenMintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_mint"), adminKeypair.publicKey.toBuffer(), Buffer.from(VAULT_NAME)],
    program.programId
  );

  const [mockOraclePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mock_oracle"), adminKeypair.publicKey.toBuffer()],
    program.programId
  );

  const [marinadeStrategyPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("marinade_strategy"), vaultPda.toBuffer()],
    marinadeProgram.programId
  );

  // Derive mSOL ATA for strategy
  const msolAta = await getAssociatedTokenAddress(MSOL_MINT, marinadeStrategyPda, true);

  console.log("Vault PDA:", vaultPda.toString());
  console.log("Vault Token Mint:", vaultTokenMintPda.toString());
  console.log("Mock Oracle:", mockOraclePda.toString());
  console.log("Marinade Strategy:", marinadeStrategyPda.toString());
  console.log("Strategy mSOL ATA:", msolAta.toString());

  // Get ATAs for vault
  const btcAta = await getAssociatedTokenAddress(BTC_MINT, vaultPda, true);
  const ethAta = await getAssociatedTokenAddress(ETH_MINT, vaultPda, true);
  const solAta = await getAssociatedTokenAddress(SOL_MINT, vaultPda, true);

  // Check if vault already exists
  try {
    const vaultAccount = await program.account.vault.fetch(vaultPda);
    console.log("✅ Vault already exists!");
    console.log("   Name:", vaultAccount.name);
    console.log("   Admin:", vaultAccount.admin.toString());
    console.log("   Assets:", vaultAccount.assets.length);
    return;
  } catch (e) {
    console.log("Vault doesn't exist, creating...");
  }

  // Step 1: Initialize Mock Oracle
  console.log("\n📊 Step 1: Initialize Mock Oracle...");
  try {
    const oracleAccount = await program.account.mockPriceOracle.fetch(mockOraclePda);
    console.log("✅ Mock Oracle already initialized");
  } catch (e) {
    await program.methods
      .initializeMockOracle()
      .accounts({
        authority: adminKeypair.publicKey,
      })
      .signers([adminKeypair])
      .rpc();
    console.log("✅ Mock Oracle initialized");
  }

  // Step 2: Update prices
  console.log("\n💰 Step 2: Update Mock Oracle Prices...");
  await (program.methods as any)
    .updateMockOracle(
      new anchor.BN(108_277 * 1_000_000), // BTC: $108,277
      new anchor.BN(3_876 * 1_000_000),   // ETH: $3,876
      new anchor.BN(184 * 1_000_000)      // SOL: $184
    )
    .accounts({
      mockOracle: mockOraclePda,
      authority: adminKeypair.publicKey,
    })
    .signers([adminKeypair])
    .rpc();
  console.log("✅ Prices updated: BTC=$108,277, ETH=$3,876, SOL=$184");

  // Step 3: Create Vault
  console.log("\n🏦 Step 3: Create Vault...");
  const assets = [
    { mint: BTC_MINT, weight: 40, ata: btcAta },
    { mint: ETH_MINT, weight: 30, ata: ethAta },
    { mint: SOL_MINT, weight: 30, ata: solAta },
  ];

  await program.methods
    .createVault(VAULT_NAME, assets)
    .accounts({
      admin: adminKeypair.publicKey,
    })
    .remainingAccounts([
      { pubkey: BTC_MINT, isWritable: false, isSigner: false },
      { pubkey: btcAta, isWritable: true, isSigner: false },
      { pubkey: ETH_MINT, isWritable: false, isSigner: false },
      { pubkey: ethAta, isWritable: true, isSigner: false },
      { pubkey: SOL_MINT, isWritable: false, isSigner: false },
      { pubkey: solAta, isWritable: true, isSigner: false },
    ])
    .signers([adminKeypair])
    .rpc();
  console.log("✅ Vault created");

  // Step 4: Set price source to Mock Oracle
  console.log("\n🎯 Step 4: Set Price Source to Mock Oracle...");
  await (program.methods as any)
    .setPriceSource(VAULT_NAME, { mockOracle: {} }, mockOraclePda)
    .accounts({
      vault: vaultPda,
      authority: adminKeypair.publicKey,
    })
    .signers([adminKeypair])
    .rpc();
  console.log("✅ Price source set to Mock Oracle");

  // Step 5: Initialize Marinade Strategy
  console.log("\n🌊 Step 5: Initialize Marinade Strategy...");
  try {
    await marinadeProgram.account.strategyAccount.fetch(marinadeStrategyPda);
    console.log("✅ Marinade Strategy already initialized");
  } catch (e) {
    await (marinadeProgram.methods as any)
      .initialize()
      .accounts({
        strategyAccount: marinadeStrategyPda,
        vault: vaultPda,
        payer: adminKeypair.publicKey,
        systemProgram: SystemProgram.programId,
        msolAta: msolAta,
        msolMint: MSOL_MINT,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([adminKeypair])
      .rpc();
    console.log("✅ Marinade Strategy initialized");
  }

  // Step 6: Link Marinade Strategy to Vault
  console.log("\n🔗 Step 6: Link Marinade Strategy to Vault...");
  await (program.methods as any)
    .setStrategy(VAULT_NAME, marinadeStrategyPda)
    .accounts({
      vault: vaultPda,
      authority: adminKeypair.publicKey,
    })
    .signers([adminKeypair])
    .rpc();
  console.log("✅ Marinade Strategy linked to vault");

  console.log("\n✅ VAULT INITIALIZATION COMPLETE!");
  console.log("\n📋 Frontend Configuration:");
  console.log(`VAULT_PROGRAM_ID: ${program.programId.toString()}`);
  console.log(`VAULT_ADMIN: ${adminKeypair.publicKey.toString()}`);
  console.log(`VAULT_NAME: ${VAULT_NAME}`);
  console.log(`MOCK_ORACLE: ${mockOraclePda.toString()}`);
  console.log(`MARINADE_STRATEGY_PROGRAM: ${marinadeProgram.programId.toString()}`);
  console.log(`\nVault Address: ${vaultPda.toString()}`);
}

initializeVault()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
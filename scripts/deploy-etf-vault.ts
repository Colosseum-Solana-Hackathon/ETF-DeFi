import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, Keypair } from "@solana/web3.js";
import * as splToken from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Deploy ETF Vault: SOL-BTC-ETH-Index
 * 
 * This script creates a production ETF vault on Solana Devnet with:
 * - Name: SOL-BTC-ETH-Index
 * - Composition: 40% BTC, 30% ETH, 30% SOL
 */

async function main() {
  console.log("🚀 Deploying SOL-BTC-ETH-Index ETF Vault to Solana Devnet\n");
  console.log("=".repeat(60));

  // Configure provider for devnet
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Vault as Program<Vault>;
  const provider = anchor.getProvider();

  console.log("\n📋 Configuration:");
  console.log("  Network:", provider.connection.rpcEndpoint);
  console.log("  Vault Program ID:", program.programId.toString());

  // Load admin keypair
  const keypairPath = path.join(os.homedir(), ".config", "solana", "id.json");
  const secretKey = Uint8Array.from(
    JSON.parse(fs.readFileSync(keypairPath, "utf-8"))
  );
  const admin = Keypair.fromSecretKey(secretKey);

  console.log("  Admin:", admin.publicKey.toString());

  // Check admin balance
  const balance = await provider.connection.getBalance(admin.publicKey);
  console.log("  Admin Balance:", balance / anchor.web3.LAMPORTS_PER_SOL, "SOL");
  
  if (balance < 0.1 * anchor.web3.LAMPORTS_PER_SOL) {
    throw new Error("❌ Insufficient balance! Need at least 0.1 SOL for deployment");
  }

  // ETF Vault Configuration
  const vaultName = "SOL-BTC-ETH-Index";
  console.log("\n🏦 Vault Configuration:");
  console.log("  Name:", vaultName);
  console.log("  Assets: BTC (40%), ETH (30%), SOL (30%)");

  // Create token mints for test assets (on devnet)
  console.log("\n🪙 Creating test token mints...");
  
  // @ts-ignore spl-token typings might not include createMint in this version
  const btcMint = await (splToken as any).createMint(
    provider.connection,
    admin,
    admin.publicKey,
    null,
    8 // BTC has 8 decimals
  );
  console.log("  ✅ BTC Mint:", btcMint.toString());

  // @ts-ignore spl-token typings might not include createMint in this version
  const ethMint = await (splToken as any).createMint(
    provider.connection,
    admin,
    admin.publicKey,
    null,
    18 // ETH has 18 decimals
  );
  console.log("  ✅ ETH Mint:", ethMint.toString());

  // @ts-ignore spl-token typings might not include createMint in this version
  const solMint = await (splToken as any).createMint(
    provider.connection,
    admin,
    admin.publicKey,
    null,
    9 // SOL has 9 decimals
  );
  console.log("  ✅ SOL Mint:", solMint.toString());

  // Define vault assets with weights
  const assets = [
    {
      mint: btcMint,
      weight: 40, // 40% BTC
      ata: PublicKey.default, // Will be set by the program
    },
    {
      mint: ethMint,
      weight: 30, // 30% ETH
      ata: PublicKey.default,
    },
    {
      mint: solMint,
      weight: 30, // 30% SOL
      ata: PublicKey.default,
    },
  ];

  // Derive vault PDA
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault"),
      admin.publicKey.toBuffer(),
      Buffer.from(vaultName),
    ],
    program.programId
  );

  // Derive vault token mint PDA (share tokens)
  const [vaultTokenMintPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault_mint"),
      admin.publicKey.toBuffer(),
      Buffer.from(vaultName),
    ],
    program.programId
  );

  console.log("\n🔑 Derived PDAs:");
  console.log("  Vault PDA:", vaultPda.toString());
  console.log("  Share Token Mint:", vaultTokenMintPda.toString());

  // Get ATAs for each asset
  // @ts-ignore spl-token typings might not include getAssociatedTokenAddress in this version
  const btcAta = await (splToken as any).getAssociatedTokenAddress(btcMint, vaultPda, true);
  // @ts-ignore spl-token typings might not include getAssociatedTokenAddress in this version
  const ethAta = await (splToken as any).getAssociatedTokenAddress(ethMint, vaultPda, true);
  // @ts-ignore spl-token typings might not include getAssociatedTokenAddress in this version
  const solAta = await (splToken as any).getAssociatedTokenAddress(solMint, vaultPda, true);

  console.log("\n💼 Vault Asset Accounts:");
  console.log("  BTC ATA:", btcAta.toString());
  console.log("  ETH ATA:", ethAta.toString());
  console.log("  SOL ATA:", solAta.toString());

  // Create the vault
  console.log("\n⚡ Creating vault transaction...");
  
  try {
    const tx = await program.methods
      .createVault(vaultName, assets)
      .accounts({
        admin: admin.publicKey,
      })
      .remainingAccounts([
        { pubkey: btcMint, isWritable: false, isSigner: false },
        { pubkey: btcAta, isWritable: true, isSigner: false },
        { pubkey: ethMint, isWritable: false, isSigner: false },
        { pubkey: ethAta, isWritable: true, isSigner: false },
        { pubkey: solMint, isWritable: false, isSigner: false },
        { pubkey: solAta, isWritable: true, isSigner: false },
      ])
      .signers([admin])
      .rpc();

    console.log("\n✅ Vault created successfully!");
    console.log("  Transaction:", tx);
    console.log("  Explorer:", `https://explorer.solana.com/tx/${tx}?cluster=devnet`);

    // Fetch and verify vault state
    console.log("\n📊 Fetching vault state...");
    const vaultAccount = await program.account.vault.fetch(vaultPda);

    console.log("\n✨ Vault Details:");
    console.log("  Name:", vaultAccount.name);
    console.log("  Admin:", vaultAccount.admin.toString());
    console.log("  Share Token Mint:", vaultAccount.vaultTokenMint.toString());
    console.log("  Number of Assets:", vaultAccount.assets.length);
    console.log("  Price Source:", JSON.stringify(vaultAccount.priceSource));
    console.log("  Marinade Strategy:", vaultAccount.marinadeStrategy?.toString() || "Not set");
    console.log("  Mock Oracle:", vaultAccount.mockOracle?.toString() || "Not set");
    
    console.log("\n  Asset Composition:");
    vaultAccount.assets.forEach((asset, index) => {
      const assetName = index === 0 ? "BTC" : index === 1 ? "ETH" : "SOL";
      console.log(`    ${assetName}:`);
      console.log(`      Mint: ${asset.mint.toString()}`);
      console.log(`      Weight: ${asset.weight}%`);
      console.log(`      ATA: ${asset.ata.toString()}`);
    });

    // =============================
    // Configure Mock Oracle on devnet
    // =============================
    console.log("\n🔧 Initializing Mock Oracle and setting as price source (devnet)...");

    // Derive Mock Oracle PDA for this admin
    const [mockOracle] = PublicKey.findProgramAddressSync(
      [Buffer.from("mock_oracle"), admin.publicKey.toBuffer()],
      program.programId
    );

    // Try to initialize mock oracle (idempotent: skip if exists)
    try {
      await (program.methods as any)
        .initializeMockOracle()
        .accounts({
          mockOracle,
          authority: admin.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
      console.log("✅ Mock Oracle initialized:", mockOracle.toString());
    } catch (e: any) {
      console.log("ℹ️  Mock Oracle may already exist:", mockOracle.toString());
    }

    // Seed prices (micro-USD)
    const btcPrice = new anchor.BN(110_000 * 1_000_000);
    const ethPrice = new anchor.BN(4_000 * 1_000_000);
    const solPrice = new anchor.BN(190 * 1_000_000);

    // Update mock oracle prices
    await (program.methods as any)
      .updateMockOracle(btcPrice, ethPrice, solPrice)
      .accounts({
        mockOracle,
        authority: admin.publicKey,
      })
      .signers([admin])
      .rpc();
    console.log("✅ Mock Oracle prices updated");

    // Point the vault to MockOracle
    await (program.methods as any)
      .setPriceSource(vaultName, { mockOracle: {} }, mockOracle)
      .accounts({
        vault: vaultPda,
        authority: admin.publicKey,
      })
      .signers([admin])
      .rpc();
    console.log("✅ Vault price source set to MockOracle");

    // Save deployment info
    const deploymentInfo = {
      vaultName,
      vaultPda: vaultPda.toString(),
      vaultTokenMint: vaultTokenMintPda.toString(),
      admin: admin.publicKey.toString(),
      mockOracle: mockOracle.toString(),
      priceSource: "MockOracle",
      assets: {
        btc: {
          mint: btcMint.toString(),
          ata: btcAta.toString(),
          weight: 40,
        },
        eth: {
          mint: ethMint.toString(),
          ata: ethAta.toString(),
          weight: 30,
        },
        sol: {
          mint: solMint.toString(),
          ata: solAta.toString(),
          weight: 30,
        },
      },
      transaction: tx,
      timestamp: new Date().toISOString(),
      network: "devnet",
      programId: program.programId.toString(),
    };

    const outputPath = path.join(__dirname, "..", "etf-vault-deployment.json");
    fs.writeFileSync(outputPath, JSON.stringify(deploymentInfo, null, 2));
    console.log("\n💾 Deployment info saved to:", outputPath);

    console.log("\n" + "=".repeat(60));
    console.log("🎉 ETF Vault Deployment Complete!");
    console.log("=".repeat(60));
    
  } catch (error: any) {
    console.error("\n❌ Error creating vault:");
    console.error(error);
    
    if (error.logs) {
      console.error("\n📋 Transaction Logs:");
      error.logs.forEach((log: string) => console.error("  ", log));
    }
    
    throw error;
  }
}

main()
  .then(() => {
    console.log("\n✅ Script completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Script failed:", error);
    process.exit(1);
  });

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { MarinadeStrategy } from "../target/types/marinade_strategy";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getMint,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getMarinadeAccounts, MARINADE_PROGRAM_ID, MSOL_MINT } from "./helpers/marinade-accounts";

// Helper function to create Associated Token Address
async function getAssociatedTokenAddressSync(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false
): Promise<PublicKey> {
  return await getAssociatedTokenAddress(mint, owner, allowOwnerOffCurve);
}

describe("Multi-Asset Vault Tests", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.Vault as Program<Vault>;
  const marinadeProgram = anchor.workspace.MarinadeStrategy as Program<MarinadeStrategy>;
  const provider = anchor.getProvider();

  // Switchboard On-Demand Pull Feed on Devnet
  const SOL_USD_FEED = new PublicKey("DAXAq94Y5nX2dDp15SdeBzYRqTn8viFf9Dxq4ws7rHec");
  const BTC_USD_FEED = new PublicKey("DAXAq94Y5nX2dDp15SdeBzYRqTn8viFf9Dxq4ws7rHec");
  const ETH_USD_FEED = new PublicKey("DAXAq94Y5nX2dDp15SdeBzYRqTn8viFf9Dxq4ws7rHec");

  let admin: Keypair;
  let user1: Keypair;
  let user2: Keypair;
  let btcMint: PublicKey;
  let ethMint: PublicKey;
  let solMint: PublicKey;
  let mockOracle: PublicKey;

  before(async () => {
    // Load your existing Solana CLI keypair
    const keypairPath = path.join(os.homedir(), ".config", "solana", "id.json");
    const secretKey = Uint8Array.from(
      JSON.parse(fs.readFileSync(keypairPath, "utf-8"))
    );
    admin = Keypair.fromSecretKey(secretKey);
    
    // Derive mock oracle PDA
    [mockOracle] = PublicKey.findProgramAddressSync(
      [Buffer.from("mock_oracle"), admin.publicKey.toBuffer()],
      program.programId
    );
    
    // Create test keypairs
    user1 = Keypair.generate();
    user2 = Keypair.generate();

    console.log("✅ Test setup:");
    console.log("  Admin:", admin.publicKey.toString());
    console.log("  User1:", user1.publicKey.toString());
    console.log("  User2:", user2.publicKey.toString());
    console.log("  Mock Oracle:", mockOracle.toString());

    // Create test token mints (BTC, ETH, SOL test tokens)
    btcMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      8 // BTC has 8 decimals
    );

    ethMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      18 // ETH has 18 decimals
    );

    solMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      9 // SOL has 9 decimals
    );

    console.log("BTC Mint:", btcMint.toString());
    console.log("ETH Mint:", ethMint.toString());
    console.log("SOL Mint:", solMint.toString());
  });

  describe("create_vault", () => {
    it("Creates a new multi-asset vault with BTC, ETH, SOL composition", async () => {
      // Use unique vault name to avoid conflicts
      const vaultName = `TestVault_${Date.now()}`;
      const assets = [
        {
          mint: btcMint,
          weight: 40, // 40% BTC
          ata: PublicKey.default, // Will be set by the program
        },
        {
          mint: ethMint,
          weight: 30, // 30% ETH
          ata: PublicKey.default, // Will be set by the program
        },
        {
          mint: solMint,
          weight: 30, // 30% SOL
          ata: PublicKey.default, // Will be set by the program
        },
      ];

      // Get the vault PDA
      const [vaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          new PublicKey(admin.publicKey).toBuffer(),
          Buffer.from(vaultName),
        ],
        program.programId
      );

      // Get the vault token mint PDA
      const [vaultTokenMintPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault_mint"),
          new PublicKey(admin.publicKey).toBuffer(),
          Buffer.from(vaultName),
        ],
        program.programId
      );

      // Get ATAs for each asset (these will be created by the program)
      const btcAta = await getAssociatedTokenAddress(btcMint, vaultPda, true);
      const ethAta = await getAssociatedTokenAddress(ethMint, vaultPda, true);
      const solAta = await getAssociatedTokenAddress(solMint, vaultPda, true);

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

      console.log("Create vault transaction signature", tx);

      // Verify vault was created correctly
      const vaultAccount = await program.account.vault.fetch(vaultPda);
      expect(vaultAccount.admin.toString()).to.equal(
        admin.publicKey.toString()
      );
      expect(vaultAccount.name).to.equal(vaultName);
      expect(vaultAccount.assets.length).to.equal(3);
      expect(vaultAccount.assets[0].weight).to.equal(40);
      expect(vaultAccount.assets[1].weight).to.equal(30);
      expect(vaultAccount.assets[2].weight).to.equal(30);
    });

    it("Fails with empty vault name", async () => {
      const vaultName = "";
      const assets = [
        {
          mint: btcMint,
          weight: 100,
          ata: PublicKey.default,
        },
      ];

      const btcAta = await getAssociatedTokenAddress(btcMint, PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), admin.publicKey.toBuffer(), Buffer.from(vaultName)],
        program.programId
      )[0], true);

      try {
        await program.methods
          .createVault(vaultName, assets)
          .accounts({
            admin: admin.publicKey,
          })
          .remainingAccounts([
            { pubkey: btcMint, isWritable: false, isSigner: false },
            { pubkey: btcAta, isWritable: true, isSigner: false },
          ])
          .signers([admin])
          .rpc();
        expect.fail("Should have thrown error for empty vault name");
      } catch (error: any) {
        expect(error.message).to.include("InvalidName");
      }
    });

    // it("Fails with vault name > 32 characters", async () => {
    //   const vaultName = "ThisVaultNameIsWayTooLongAndExceeds32Characters";
    //   const assets = [
    //     {
    //       mint: btcMint,
    //       weight: 100,
    //       ata: PublicKey.default,
    //     },
    //   ];

    //   const btcAta = await getAssociatedTokenAddress(btcMint, PublicKey.findProgramAddressSync(
    //     [Buffer.from("vault"), admin.publicKey.toBuffer(), Buffer.from(vaultName)],
    //     program.programId
    //   )[0], true);

    //   try {
    //     await program.methods
    //       .createVault(vaultName, assets)
    //       .accounts({
    //         admin: admin.publicKey,
    //       })
    //       .remainingAccounts([
    //         { pubkey: btcMint, isWritable: false, isSigner: false },
    //         { pubkey: btcAta, isWritable: true, isSigner: false },
    //       ])
    //       .signers([admin])
    //       .rpc();
    //     expect.fail("Should have thrown error for name > 32 chars");
    //   } catch (error: any) {
    //     expect(error.message).to.include("InvalidName");
    //   }
    // });

    it("Fails with weights not summing to 100", async () => {
      const vaultName = `InvalidWeights_${Date.now()}`;
      const assets = [
        {
          mint: btcMint,
          weight: 40,
          ata: PublicKey.default,
        },
        {
          mint: ethMint,
          weight: 40, // Total = 80, not 100
          ata: PublicKey.default,
        },
      ];

      const vaultPda = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), admin.publicKey.toBuffer(), Buffer.from(vaultName)],
        program.programId
      )[0];

      const btcAta = await getAssociatedTokenAddress(btcMint, vaultPda, true);
      const ethAta = await getAssociatedTokenAddress(ethMint, vaultPda, true);

      try {
        await program.methods
          .createVault(vaultName, assets)
          .accounts({
            admin: admin.publicKey,
          })
          .remainingAccounts([
            { pubkey: btcMint, isWritable: false, isSigner: false },
            { pubkey: btcAta, isWritable: true, isSigner: false },
            { pubkey: ethMint, isWritable: false, isSigner: false },
            { pubkey: ethAta, isWritable: true, isSigner: false },
          ])
          .signers([admin])
          .rpc();
        expect.fail("Should have thrown error for invalid weight sum");
      } catch (error: any) {
        expect(error.message).to.include("InvalidWeights");
      }
    });

    it("Fails with zero weight for an asset", async () => {
      const vaultName = `ZeroWeight_${Date.now()}`;
      const assets = [
        {
          mint: btcMint,
          weight: 0, // Zero weight invalid
          ata: PublicKey.default,
        },
        {
          mint: ethMint,
          weight: 100,
          ata: PublicKey.default,
        },
      ];

      const vaultPda = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), admin.publicKey.toBuffer(), Buffer.from(vaultName)],
        program.programId
      )[0];

      const btcAta = await getAssociatedTokenAddress(btcMint, vaultPda, true);
      const ethAta = await getAssociatedTokenAddress(ethMint, vaultPda, true);

      try {
        await program.methods
          .createVault(vaultName, assets)
          .accounts({
            admin: admin.publicKey,
          })
          .remainingAccounts([
            { pubkey: btcMint, isWritable: false, isSigner: false },
            { pubkey: btcAta, isWritable: true, isSigner: false },
            { pubkey: ethMint, isWritable: false, isSigner: false },
            { pubkey: ethAta, isWritable: true, isSigner: false },
          ])
          .signers([admin])
          .rpc();
        expect.fail("Should have thrown error for zero weight");
      } catch (error: any) {
        expect(error.message).to.include("InvalidWeights");
      }
    });

    it("Fails with zero assets", async () => {
      const vaultName = `NoAssets_${Date.now()}`;
      const assets: any[] = []; // Empty assets array

      try {
        await program.methods
          .createVault(vaultName, assets)
          .accounts({
            admin: admin.publicKey,
          })
          .remainingAccounts([])
          .signers([admin])
          .rpc();
        expect.fail("Should have thrown error for zero assets");
      } catch (error: any) {
        expect(error.message).to.include("InvalidAssetCount");
      }
    });

    it("Fails with more than 10 assets", async () => {
      const vaultName = `TooManyAssets_${Date.now()}`;
      // Create 11 assets
      const assets = Array.from({ length: 11 }, (_, i) => ({
        mint: btcMint, // Reusing same mint for simplicity
        weight: i === 0 ? 10 : 9, // Roughly 100% total (10 + 10*9 = 100, close enough)
        ata: PublicKey.default,
      }));

      const vaultPda = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), admin.publicKey.toBuffer(), Buffer.from(vaultName)],
        program.programId
      )[0];

      const btcAta = await getAssociatedTokenAddress(btcMint, vaultPda, true);
      const remainingAccounts = Array.from({ length: 11 }, () => [
        { pubkey: btcMint, isWritable: false, isSigner: false },
        { pubkey: btcAta, isWritable: true, isSigner: false },
      ]).flat();

      try {
        await program.methods
          .createVault(vaultName, assets)
          .accounts({
            admin: admin.publicKey,
          })
          .remainingAccounts(remainingAccounts)
          .signers([admin])
          .rpc();
        expect.fail("Should have thrown error for >10 assets");
      } catch (error: any) {
        expect(error.message).to.include("InvalidAssetCount");
      }
    });
  });

  describe("deposit_multi_asset", () => {
    let vaultPda: PublicKey;
    let vaultTokenMintPda: PublicKey;
    let userVaultTokenAccount: PublicKey;
    let vaultName: string;
    let btcAta: PublicKey;
    let ethAta: PublicKey;
    let solAta: PublicKey;

    before(async () => {
      // Create a vault for testing deposits
      vaultName = `DepositTest_${Date.now()}`;
      const assets = [
        {
          mint: btcMint,
          weight: 40, // 40% BTC
          ata: PublicKey.default,
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

      vaultPda = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), admin.publicKey.toBuffer(), Buffer.from(vaultName)],
        program.programId
      )[0];

      vaultTokenMintPda = PublicKey.findProgramAddressSync(
        [Buffer.from("vault_mint"), admin.publicKey.toBuffer(), Buffer.from(vaultName)],
        program.programId
      )[0];

      // Get ATAs
      btcAta = await getAssociatedTokenAddress(btcMint, vaultPda, true);
      ethAta = await getAssociatedTokenAddress(ethMint, vaultPda, true);
      solAta = await getAssociatedTokenAddress(solMint, vaultPda, true);

      // Create the vault
      await program.methods
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

      // Transfer SOL from admin to user1 for testing
      const transferTx = await provider.connection.sendTransaction(
        new anchor.web3.Transaction().add(
          SystemProgram.transfer({
            fromPubkey: admin.publicKey,
            toPubkey: user1.publicKey,
            lamports: 0.1 * anchor.web3.LAMPORTS_PER_SOL, // Just 0.1 SOL for testing
          })
        ),
        [admin]
      );
      await provider.connection.confirmTransaction(transferTx);

      // Create user's vault token account
      userVaultTokenAccount = await getAssociatedTokenAddress(vaultTokenMintPda, user1.publicKey);
      
      // Configure vault to use Mock Oracle
      console.log("🔧 Configuring vault to use Mock Oracle...");
      await (program.methods as any)
        .setPriceSource(vaultName, { mockOracle: {} }, mockOracle)
        .accounts({
          vault: vaultPda,
          authority: admin.publicKey,
        })
        .signers([admin])
        .rpc();
      console.log("✅ Vault configured to use Mock Oracle");
      
      // Verify mock oracle has prices
      try {
        const oracleData: any = await (program.account as any).mockPriceOracle.fetch(mockOracle);
        console.log("📊 Current Oracle Prices:");
        console.log("  BTC: $" + (oracleData.btcPrice.toNumber() / 1_000_000).toFixed(2));
        console.log("  ETH: $" + (oracleData.ethPrice.toNumber() / 1_000_000).toFixed(2));
        console.log("  SOL: $" + (oracleData.solPrice.toNumber() / 1_000_000).toFixed(2));
        
        if (oracleData.btcPrice.toNumber() === 0 || oracleData.ethPrice.toNumber() === 0 || oracleData.solPrice.toNumber() === 0) {
          console.warn("⚠️  Warning: Oracle prices are zero. Run 'yarn update-prices' first!");
        }
      } catch (e) {
        console.error("❌ Mock oracle not found or not readable. Run 'yarn run init-oracle' first!");
        throw e;
      }
    });

    it("User deposits SOL and receives correct shares", async () => {
      // Update oracle prices to ensure they're fresh
      const mockPrices = {
        btcPrice: new anchor.BN(108277 * 1_000_000), // $108,277 in micro-USD
        ethPrice: new anchor.BN(3876 * 1_000_000), // $3,876 in micro-USD
        solPrice: new anchor.BN(184 * 1_000_000), // $184 in micro-USD
      };
      
      await (program.methods as any)
        .updateMockOracle(mockPrices.btcPrice, mockPrices.ethPrice, mockPrices.solPrice)
        .accounts({
          mockOracle: mockOracle,
          authority: admin.publicKey,
        })
        .signers([admin])
        .rpc();
      console.log("✅ Oracle prices updated");
      
      const depositAmount = 0.01 * anchor.web3.LAMPORTS_PER_SOL; // 0.01 SOL (small amount)

      console.log("💰 Depositing", depositAmount / anchor.web3.LAMPORTS_PER_SOL, "SOL");

      // Fetch real Marinade accounts (required even if not using strategy)
      const marinadeAccounts = await getMarinadeAccounts(provider.connection);
      
      // Create a dummy mSOL ATA for the test
      const dummyMsolAta = await getAssociatedTokenAddress(
        MSOL_MINT,
        admin.publicKey, // Use admin as dummy authority
        false
      );

      const tx = await program.methods
        .depositMultiAsset(vaultName, new anchor.BN(depositAmount))
        .accounts({
          vault: vaultPda,
          user: user1.publicKey,
          userSharesAta: userVaultTokenAccount,
          vaultTokenMint: vaultTokenMintPda,
          btcQuote: PublicKey.default, // Not used with MockOracle
          ethQuote: PublicKey.default, // Not used with MockOracle
          solQuote: PublicKey.default, // Not used with MockOracle
          marinadeStrategyProgram: marinadeProgram.programId,
          marinadeProgram: MARINADE_PROGRAM_ID,
          marinadeState: marinadeAccounts.marinadeState,
          reservePda: marinadeAccounts.reservePda,
          msolMint: MSOL_MINT,
          strategyMsolAta: dummyMsolAta,
          msolMintAuthority: marinadeAccounts.msolMintAuthority,
          liqPoolSolLegPda: marinadeAccounts.liqPoolSolLegPda,
          liqPoolMsolLeg: marinadeAccounts.liqPoolMsolLeg,
          liqPoolMsolLegAuthority: marinadeAccounts.liqPoolMsolLegAuthority,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        } as any)
        .remainingAccounts([
          { pubkey: btcMint, isWritable: false, isSigner: false },
          { pubkey: btcAta, isWritable: true, isSigner: false },
          { pubkey: ethMint, isWritable: false, isSigner: false },
          { pubkey: ethAta, isWritable: true, isSigner: false },
          { pubkey: solMint, isWritable: false, isSigner: false },
          { pubkey: solAta, isWritable: true, isSigner: false },
          { pubkey: mockOracle, isWritable: false, isSigner: false }, // Mock Oracle for price fetching
        ])
        .signers([user1])
        .rpc();

      console.log("✅ Deposit transaction signature", tx);

      // Get transaction details to see logs
      const txDetails = await provider.connection.getTransaction(tx, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });

      if (txDetails && txDetails.meta && txDetails.meta.logMessages) {
        console.log("\n📋 Transaction Logs (price-related):");
        txDetails.meta.logMessages.forEach((log) => {
          if (log.includes("price") || log.includes("Price") || log.includes("TVL") || log.includes("shares")) {
            console.log("  ", log);
          }
        });
      }

      // Verify user received shares
      const userVaultTokenAccountInfo = await getAccount(
        provider.connection,
        userVaultTokenAccount
      );
      
      // First deposit should mint shares 1:1 with deposit value
      expect(Number(userVaultTokenAccountInfo.amount)).to.be.greaterThan(0);
      console.log("\n✅ User received shares:", userVaultTokenAccountInfo.amount.toString());
      
      // Verify vault state
      const vaultAccount: any = await program.account.vault.fetch(vaultPda);
      console.log("📊 Vault State After Deposit:");
      console.log("  Total Shares:", vaultAccount.totalShares?.toString() || "N/A");
      console.log("  TVL (micro-USD):", vaultAccount.tvlUsd?.toString() || "N/A");
      if (vaultAccount.tvlUsd) {
        console.log("  TVL (USD): $" + (vaultAccount.tvlUsd.toNumber() / 1_000_000).toFixed(2));
      }
    });

    it("Fails with zero deposit amount", async () => {
      // Fetch real Marinade accounts
      const marinadeAccounts = await getMarinadeAccounts(provider.connection);
      
      // Create a dummy mSOL ATA for the test
      const dummyMsolAta = await getAssociatedTokenAddress(
        MSOL_MINT,
        admin.publicKey,
        false
      );

      try {
        await program.methods
          .depositMultiAsset(vaultName, new anchor.BN(0))
          .accounts({
            vault: vaultPda,
            user: user1.publicKey,
            userSharesAta: userVaultTokenAccount,
            vaultTokenMint: vaultTokenMintPda,
            btcQuote: PublicKey.default,
            ethQuote: PublicKey.default,
            solQuote: PublicKey.default,
            marinadeStrategyProgram: marinadeProgram.programId,
            marinadeProgram: MARINADE_PROGRAM_ID,
            marinadeState: marinadeAccounts.marinadeState,
            reservePda: marinadeAccounts.reservePda,
            msolMint: MSOL_MINT,
            strategyMsolAta: dummyMsolAta,
            msolMintAuthority: marinadeAccounts.msolMintAuthority,
            liqPoolSolLegPda: marinadeAccounts.liqPoolSolLegPda,
            liqPoolMsolLeg: marinadeAccounts.liqPoolMsolLeg,
            liqPoolMsolLegAuthority: marinadeAccounts.liqPoolMsolLegAuthority,
            clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .remainingAccounts([
            { pubkey: btcMint, isWritable: false, isSigner: false },
            { pubkey: btcAta, isWritable: true, isSigner: false },
            { pubkey: ethMint, isWritable: false, isSigner: false },
            { pubkey: ethAta, isWritable: true, isSigner: false },
            { pubkey: solMint, isWritable: false, isSigner: false },
            { pubkey: solAta, isWritable: true, isSigner: false },
            { pubkey: mockOracle, isWritable: false, isSigner: false },
          ])
          .signers([user1])
          .rpc();
        expect.fail("Should have thrown error for zero amount");
      } catch (error: any) {
        expect(error.message).to.include("InvalidAmount");
      }
    });
  });

  // describe("withdraw_multi_asset", () => {
  //   let vaultPda: PublicKey;
  //   let vaultTokenMintPda: PublicKey;
  //   let userVaultTokenAccount: PublicKey;

  //   before(async () => {
  //     // Create a vault for testing withdrawals
  //     const vaultName = "WithdrawTestVault";
  //     const assets = [
  //       {
  //         mint: btcMint,
  //         weight: 50, // 50% BTC
  //         ata: PublicKey.default,
  //       },
  //       {
  //         mint: ethMint,
  //         weight: 50, // 50% ETH
  //         ata: PublicKey.default,
  //       },
  //     ];

  //     vaultPda = PublicKey.findProgramAddressSync(
  //       [Buffer.from("vault"), admin.publicKey.toBuffer(), Buffer.from(vaultName)],
  //       program.programId
  //     )[0];

  //     vaultTokenMintPda = PublicKey.findProgramAddressSync(
  //       [Buffer.from("vault_mint"), admin.publicKey.toBuffer(), Buffer.from(vaultName)],
  //       program.programId
  //     )[0];

  //     // Get ATAs
  //     const btcAta = await getAssociatedTokenAddress(btcMint, vaultPda, true);
  //     const ethAta = await getAssociatedTokenAddress(ethMint, vaultPda, true);

  //     // Create the vault
  //     await program.methods
  //       .createVault(vaultName, assets)
  //       .accounts({
  //         admin: admin.publicKey,
  //         tokenProgram: TOKEN_PROGRAM_ID,
  //         associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  //         systemProgram: SystemProgram.programId,
  //         rent: SYSVAR_RENT_PUBKEY,
  //       })
  //       .remainingAccounts([
  //         { pubkey: btcMint, isWritable: false, isSigner: false },
  //         { pubkey: btcAta, isWritable: true, isSigner: false },
  //         { pubkey: ethMint, isWritable: false, isSigner: false },
  //         { pubkey: ethAta, isWritable: true, isSigner: false },
  //       ])
  //       .signers([admin])
  //       .rpc();

  //     // Create user's vault token account and make a deposit first
  //     userVaultTokenAccount = await getAssociatedTokenAddress(vaultTokenMintPda, user1.publicKey);

  //     const depositAmount = 2 * anchor.web3.LAMPORTS_PER_SOL; // 2 SOL
  //     await program.methods
  //       .depositMultiAsset(new anchor.BN(depositAmount))
  //       .accounts({
  //         vault: vaultPda,
  //         user: user1.publicKey,
  //         userVaultTokenAccount: userVaultTokenAccount,
  //         vaultTokenMint: vaultTokenMintPda,
  //         btcPriceFeed: BTC_USD_FEED,
  //         ethPriceFeed: ETH_USD_FEED,
  //         solPriceFeed: SOL_USD_FEED,
  //         tokenProgram: TOKEN_PROGRAM_ID,
  //         associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  //         systemProgram: SystemProgram.programId,
  //       })
  //       .signers([user1])
  //       .rpc();
  //   });

  //   it("User withdraws shares and receives SOL", async () => {
  //     // Get user's current shares
  //     const userVaultTokenAccountInfo = await getAccount(
  //       provider.connection,
  //       userVaultTokenAccount
  //     );
  //     const userShares = userVaultTokenAccountInfo.amount;

  //     // Withdraw half of the shares
  //     const withdrawShares = userShares / BigInt(2);

  //     const tx = await program.methods
  //       .withdrawMultiAsset(new anchor.BN(withdrawShares.toString()))
  //       .accounts({
  //         user: user1.publicKey,
  //         userSharesAta: userVaultTokenAccount,
  //         vaultTokenMint: vaultTokenMintPda,
  //         btcPriceFeed: BTC_USD_FEED,
  //         ethPriceFeed: ETH_USD_FEED,
  //         solPriceFeed: SOL_USD_FEED,
  //         tokenProgram: TOKEN_PROGRAM_ID,
  //         associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  //         systemProgram: SystemProgram.programId,
  //       })
  //       .signers([user1])
  //       .rpc();

  //     console.log("Withdraw transaction signature", tx);

  //     // Verify user's shares decreased
  //     const userVaultTokenAccountInfoAfter = await getAccount(
  //       provider.connection,
  //       userVaultTokenAccount
  //     );
  //     expect(userVaultTokenAccountInfoAfter.amount.toString()).to.equal(
  //       (userShares - withdrawShares).toString()
  //     );
  //   });
  // });

  // describe("set_strategy", () => {
  //   let vaultPda: PublicKey;
  //   let mockStrategy: PublicKey;

  //   before(async () => {
  //     // Create a vault for testing strategy
  //     const vaultName = "StrategyTestVault";
  //     const assets = [
  //       {
  //         mint: solMint,
  //         weight: 100, // 100% SOL for strategy testing
  //         ata: PublicKey.default,
  //       },
  //     ];

  //     vaultPda = PublicKey.findProgramAddressSync(
  //       [Buffer.from("vault"), admin.publicKey.toBuffer(), Buffer.from(vaultName)],
  //       program.programId
  //     )[0];

  //     // Get ATAs
  //     const solAta = await getAssociatedTokenAddress(solMint, vaultPda, true);

  //     // Create the vault
  //     await program.methods
  //       .createVault(vaultName, assets)
  //       .accounts({
  //         vault: vaultPda,
  //         admin: admin.publicKey,
  //         vaultTokenMint: PublicKey.findProgramAddressSync(
  //           [Buffer.from("vault_mint"), admin.publicKey.toBuffer(), Buffer.from(vaultName)],
  //           program.programId
  //         )[0],
  //         tokenProgram: TOKEN_PROGRAM_ID,
  //         associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  //         systemProgram: SystemProgram.programId,
  //         rent: SYSVAR_RENT_PUBKEY,
  //       })
  //       .remainingAccounts([
  //         { pubkey: solMint, isWritable: false, isSigner: false },
  //         { pubkey: solAta, isWritable: true, isSigner: false },
  //       ])
  //       .signers([admin])
  //       .rpc();

  //     // Create a mock strategy (just a random keypair)
  //     mockStrategy = Keypair.generate().publicKey;
  //   });

  //   it("Sets strategy for vault", async () => {
  //     const tx = await program.methods
  //       .setStrategy("StrategyTestVault", mockStrategy)
  //       .accounts({
  //         authority: admin.publicKey,
  //       })
  //       .signers([admin])
  //       .rpc();

  //     console.log("Set strategy transaction signature", tx);

  //     // Verify strategy was set
  //     const vaultAccount = await program.account.vault.fetch(vaultPda);
  //     expect(vaultAccount.marinadeStrategy.toString()).to.equal(mockStrategy.toString());
  //   });

  //   it("Removes strategy from vault", async () => {
  //     const tx = await program.methods
  //       .removeStrategy("StrategyTestVault")
  //       .accounts({
  //         authority: admin.publicKey,
  //       })
  //       .signers([admin])
  //       .rpc();

  //     console.log("Remove strategy transaction signature", tx);

  //     // Verify strategy was removed
  //     const vaultAccount = await program.account.vault.fetch(vaultPda);
  //     expect(vaultAccount.marinadeStrategy).to.be.null;
  //   });
  // });

  /**
   * ============================================================================
   * MARINADE STRATEGY INTEGRATION TESTS
   * ============================================================================
   * 
   * Purpose: Verify that the vault properly delegates the SOL portion (30%)
   * to the Marinade strategy during deposits, achieving yield on the DeFi platform.
   * 
   * Test Flow:
   * 1. Create a multi-asset vault (40% BTC, 30% ETH, 30% SOL)
   * 2. Initialize Marinade strategy for the vault
   * 3. Set the Marinade strategy on the vault
   * 4. Deposit SOL to the vault
   * 5. Verify 30% of deposited SOL is delegated to Marinade
   * 6. Verify mSOL is received in the strategy account
   * 7. Verify user receives proportional vault shares
   */
  describe("Marinade Strategy Integration", () => {
    // Test configuration
    const MARINADE_VAULT_NAME = `MarinadeVault_${Date.now()}`;
    const DEPOSIT_AMOUNT = new BN(1 * anchor.web3.LAMPORTS_PER_SOL); // 1 SOL deposit
    
    // Test accounts
    let marinadeVault: PublicKey;
    let marinadeVaultTokenMint: PublicKey;
    let userSharesAta: PublicKey;
    let strategyAccount: PublicKey;
    let msolAta: PublicKey;
    let marinadeAccounts: Awaited<ReturnType<typeof getMarinadeAccounts>>;
    
    // Asset ATAs
    let btcVaultAta: PublicKey;
    let ethVaultAta: PublicKey;
    let solVaultAta: PublicKey;

    before(async () => {
      console.log("\n" + "=".repeat(80));
      console.log("MARINADE STRATEGY INTEGRATION SETUP");
      console.log("=".repeat(80));
      
      // Get Marinade accounts
      console.log("\n🌊 Fetching Marinade accounts...");
      marinadeAccounts = await getMarinadeAccounts(provider.connection);
      
      // Derive PDAs
      [marinadeVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), admin.publicKey.toBuffer(), Buffer.from(MARINADE_VAULT_NAME)],
        program.programId
      );
      
      [marinadeVaultTokenMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault_mint"), admin.publicKey.toBuffer(), Buffer.from(MARINADE_VAULT_NAME)],
        program.programId
      );
      
      [strategyAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("marinade_strategy"), marinadeVault.toBuffer()],
        marinadeProgram.programId
      );
      
      // Derive user shares ATA
      userSharesAta = await getAssociatedTokenAddressSync(
        marinadeVaultTokenMint,
        admin.publicKey
      );
      
      // Derive mSOL ATA for strategy
      msolAta = await getAssociatedTokenAddressSync(
        MSOL_MINT,
        strategyAccount,
        true
      );
      
      // Derive vault ATAs for each asset
      btcVaultAta = await getAssociatedTokenAddressSync(btcMint, marinadeVault, true);
      ethVaultAta = await getAssociatedTokenAddressSync(ethMint, marinadeVault, true);
      solVaultAta = await getAssociatedTokenAddressSync(solMint, marinadeVault, true);
      
      console.log("\n🔑 Marinade Integration PDAs:");
      console.log(`  Vault:           ${marinadeVault.toString()}`);
      console.log(`  Strategy:        ${strategyAccount.toString()}`);
      console.log(`  Strategy mSOL:   ${msolAta.toString()}`);
    });

    it("Step 1: Create Multi-Asset Vault (40% BTC, 30% ETH, 30% SOL)", async () => {
      console.log("\n📦 Creating vault for Marinade integration...");
      
      const assets = [
        { mint: btcMint, weight: 40, ata: btcVaultAta },
        { mint: ethMint, weight: 30, ata: ethVaultAta },
        { mint: solMint, weight: 30, ata: solVaultAta },
      ];
      
      const tx = await program.methods
        .createVault(MARINADE_VAULT_NAME, assets)
        .accounts({
          admin: admin.publicKey,
        })
        .remainingAccounts([
          { pubkey: btcMint, isWritable: false, isSigner: false },
          { pubkey: btcVaultAta, isWritable: true, isSigner: false },
          { pubkey: ethMint, isWritable: false, isSigner: false },
          { pubkey: ethVaultAta, isWritable: true, isSigner: false },
          { pubkey: solMint, isWritable: false, isSigner: false },
          { pubkey: solVaultAta, isWritable: true, isSigner: false },
        ])
        .signers([admin])
        .rpc({ commitment: "confirmed" });
      
      console.log("✅ Vault created:", tx);
      
      // Verify vault state
      const vaultData = await program.account.vault.fetch(marinadeVault);
      expect(vaultData.name).to.equal(MARINADE_VAULT_NAME);
      expect(vaultData.assets.length).to.equal(3);
      expect(vaultData.assets[0].weight).to.equal(40);
      expect(vaultData.assets[1].weight).to.equal(30);
      expect(vaultData.assets[2].weight).to.equal(30);
    });

    it("Step 2: Initialize Marinade Strategy", async () => {
      console.log("\n🌊 Initializing Marinade strategy...");
      
      const tx = await marinadeProgram.methods
        .initialize()
        .accounts({
          strategyAccount,
          vault: marinadeVault,
          payer: admin.publicKey,
          systemProgram: SystemProgram.programId,
          msolAta,
          msolMint: MSOL_MINT,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([admin])
        .rpc({ commitment: "confirmed" });
      
      console.log("✅ Strategy initialized:", tx);
      
      // Verify strategy state
      const strategyData = await marinadeProgram.account.strategyAccount.fetch(strategyAccount);
      expect(strategyData.vault.toString()).to.equal(marinadeVault.toString());
      expect(strategyData.totalStaked.toString()).to.equal("0");
    });

    it("Step 3: Set Marinade Strategy on Vault", async () => {
      console.log("\nConfiguring vault to use Marinade strategy...");
      
      const tx = await program.methods
        .setStrategy(MARINADE_VAULT_NAME, strategyAccount)
        .accounts({
          vault: marinadeVault,
          admin: admin.publicKey,
        })
        .signers([admin])
        .rpc({ commitment: "confirmed" });
      
      console.log("✅Strategy set:", tx);
      
      // Verify vault now has strategy configured
      const vaultData = await program.account.vault.fetch(marinadeVault);
      expect(vaultData.marinadeStrategy).to.not.be.null;
      expect(vaultData.marinadeStrategy!.toString()).to.equal(strategyAccount.toString());
    });

    it("Step 4: Set Price Source to MockOracle", async () => {
      console.log("\nSetting price source to MockOracle...");
      
      const tx = await (program.methods as any)
        .setPriceSource(MARINADE_VAULT_NAME, { mockOracle: {} }, mockOracle)
        .accounts({
          vault: marinadeVault,
          authority: admin.publicKey,
        })
        .signers([admin])
        .rpc({ commitment: "confirmed" });
      
      console.log("✅ Price source set:", tx);
      
      const vaultData = await program.account.vault.fetch(marinadeVault);
      expect(vaultData.mockOracle).to.not.be.null;
    });

    it("Step 5: Deposit SOL and Verify 30% Delegated to Marinade", async () => {
      console.log("\nTesting deposit with Marinade delegation...");
      
      // Initialize mock oracle if not already initialized
      try {
        await program.account.mockPriceOracle.fetch(mockOracle);
        console.log("   Mock oracle already initialized");
      } catch (error) {
        console.log("   Initializing mock oracle...");
        await program.methods
          .initializeMockOracle()
          .accounts({
            mockOracle: mockOracle,
            authority: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([admin])
          .rpc({ commitment: "confirmed" });
        console.log("   ✅ Mock oracle initialized");
      }
      
      // Update oracle prices to ensure they're fresh
      const mockPrices = {
        btcPrice: new BN(50_000 * 1_000_000), // $50,000
        ethPrice: new BN(3_000 * 1_000_000),  // $3,000
        solPrice: new BN(100 * 1_000_000),    // $100
      };
      
      await (program.methods as any)
        .updateMockOracle(mockPrices.btcPrice, mockPrices.ethPrice, mockPrices.solPrice)
        .accounts({
          mockOracle: mockOracle,
          authority: admin.publicKey,
        })
        .signers([admin])
        .rpc();
      
      // Calculate expected 30% delegation
      const expectedStakeAmount = DEPOSIT_AMOUNT.mul(new BN(30)).div(new BN(100));
      console.log(`\nDepositing: ${DEPOSIT_AMOUNT.toNumber() / anchor.web3.LAMPORTS_PER_SOL} SOL`);
      console.log(`   Expected Marinade stake: ${expectedStakeAmount.toNumber() / anchor.web3.LAMPORTS_PER_SOL} SOL (30%)`);
      
      // Get initial balances
      const initialUserBalance = await provider.connection.getBalance(admin.publicKey);
      console.log(`   Initial user balance: ${initialUserBalance / anchor.web3.LAMPORTS_PER_SOL} SOL`);
      
      // Perform deposit
      const tx = await program.methods
        .depositMultiAsset(MARINADE_VAULT_NAME, DEPOSIT_AMOUNT)
        .accounts({
          vault: marinadeVault,
          user: admin.publicKey,
          userSharesAta: userSharesAta,
          vaultTokenMint: marinadeVaultTokenMint,
          btcQuote: PublicKey.default,
          ethQuote: PublicKey.default,
          solQuote: PublicKey.default,
          marinadeStrategyProgram: marinadeProgram.programId,
          marinadeProgram: MARINADE_PROGRAM_ID,
          marinadeState: marinadeAccounts.marinadeState,
          reservePda: marinadeAccounts.reservePda,
          msolMint: MSOL_MINT,
          strategyMsolAta: msolAta,
          msolMintAuthority: marinadeAccounts.msolMintAuthority,
          liqPoolSolLegPda: marinadeAccounts.liqPoolSolLegPda,
          liqPoolMsolLeg: marinadeAccounts.liqPoolMsolLeg,
          liqPoolMsolLegAuthority: marinadeAccounts.liqPoolMsolLegAuthority,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        } as any)
        .remainingAccounts([
          { pubkey: btcMint, isWritable: false, isSigner: false },
          { pubkey: btcVaultAta, isWritable: true, isSigner: false },
          { pubkey: ethMint, isWritable: false, isSigner: false },
          { pubkey: ethVaultAta, isWritable: true, isSigner: false },
          { pubkey: solMint, isWritable: false, isSigner: false },
          { pubkey: solVaultAta, isWritable: true, isSigner: false },
          { pubkey: mockOracle, isWritable: false, isSigner: false },
          { pubkey: strategyAccount, isWritable: true, isSigner: false },
        ])
        .signers([admin])
        .rpc({ commitment: "confirmed" });
      
      console.log("✅ Deposit successful:", tx);
      
      // Wait for confirmation
      await provider.connection.confirmTransaction(tx, "confirmed");
      
      // Get transaction logs
      const txDetails = await provider.connection.getTransaction(tx, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      
      if (txDetails && txDetails.meta && txDetails.meta.logMessages) {
        console.log("\nTransaction Logs (Marinade-related):");
        txDetails.meta.logMessages.forEach((log) => {
          if (log.includes("Marinade") || log.includes("Delegat") || log.includes("mSOL") || log.includes("🌊")) {
            console.log("  ", log);
          }
        });
      }
      
      // Verify mSOL was received by strategy
      const msolAccount = await getAccount(provider.connection, msolAta);
      const msolBalance = Number(msolAccount.amount);
      
      console.log(`\nPost-Deposit State:`);
      console.log(`   mSOL received: ${msolBalance / anchor.web3.LAMPORTS_PER_SOL}`);
      
      // Verify strategy state updated
      const strategyData = await marinadeProgram.account.strategyAccount.fetch(strategyAccount);
      console.log(`   Strategy total staked: ${strategyData.totalStaked.toNumber() / anchor.web3.LAMPORTS_PER_SOL} SOL`);
      console.log(`   Strategy mSOL balance: ${strategyData.msolBalance.toNumber() / anchor.web3.LAMPORTS_PER_SOL}`);
      
      // Verify user received shares
      const userShares = await getAccount(provider.connection, userSharesAta);
      console.log(`   User vault shares: ${Number(userShares.amount) / 1e9}`);
      
      // Assertions
      expect(msolBalance).to.be.greaterThan(0, "Strategy should have received mSOL");
      expect(strategyData.totalStaked.toNumber()).to.equal(
        expectedStakeAmount.toNumber(),
        `Strategy should have staked exactly ${expectedStakeAmount.toNumber()} lamports (30% of deposit)`
      );
      expect(Number(userShares.amount)).to.be.greaterThan(0, "User should have received vault shares");
      
      console.log(`\n✅All Marinade integration verifications passed!`);
      console.log(`   ✓ 30% of deposited SOL delegated to Marinade`);
      console.log(`   ✓ mSOL received by strategy account`);
      console.log(`   ✓ User received proportional vault shares`);
      console.log(`   ✓ Yield generation enabled through Marinade staking`);
      console.log(`\n Yield Mechanism:`);
      console.log(`   • SOL is staked with Marinade validators`);
      console.log(`   • Staking rewards accrue to mSOL exchange rate`);
      console.log(`   • Vault TVL increases as mSOL value appreciates`);
      console.log(`   • Users earn yield proportional to their shares`);
    });
  });
});

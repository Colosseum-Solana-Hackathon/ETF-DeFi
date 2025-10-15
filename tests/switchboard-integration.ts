import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
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
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("Switchboard Real-Time Price Integration", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.Vault as Program<Vault>;
  const provider = anchor.getProvider();

  // Switchboard On-Demand Pull Feed addresses on Devnet
  // These are the official Switchboard feed PDAs on devnet
  const BTC_USD_FEED = new PublicKey("8SXvChNYFhRq4EZuZvnhjrB3jJRQCv4k3P4W6hesH3Ee");
  const ETH_USD_FEED = new PublicKey("HEvDEKuv8YyMpakwJz4Q6gKLWKQHKQRqkFqJvHrCzYbh");
  const SOL_USD_FEED = new PublicKey("GvDMxPzN1sCj7L26YDK2HnMRXEQmQ2aemov8YBtPS7vR");

  let admin: Keypair;
  let user: Keypair;
  let btcMint: PublicKey;
  let ethMint: PublicKey;
  let solMint: PublicKey;

  before(async () => {
    // Load admin keypair
    const keypairPath = path.join(os.homedir(), ".config", "solana", "id.json");
    const secretKey = Uint8Array.from(
      JSON.parse(fs.readFileSync(keypairPath, "utf-8"))
    );
    admin = Keypair.fromSecretKey(secretKey);
    user = Keypair.generate();

    console.log("\n✅ Switchboard Integration Test Setup");
    console.log("  Admin:", admin.publicKey.toString());
    console.log("  User:", user.publicKey.toString());
    console.log("\n📊 Switchboard On-Demand Feeds (Devnet):");
    console.log("  BTC/USD:", BTC_USD_FEED.toString());
    console.log("  ETH/USD:", ETH_USD_FEED.toString());
    console.log("  SOL/USD:", SOL_USD_FEED.toString());

    // Create test token mints
    btcMint = await createMint(provider.connection, admin, admin.publicKey, null, 8);
    ethMint = await createMint(provider.connection, admin, admin.publicKey, null, 18);
    solMint = await createMint(provider.connection, admin, admin.publicKey, null, 9);

    console.log("\n🪙 Test Token Mints:");
    console.log("  BTC Mint:", btcMint.toString());
    console.log("  ETH Mint:", ethMint.toString());
    console.log("  SOL Mint:", solMint.toString());
  });

  describe("Switchboard Feed Verification", () => {
    it("Verifies Switchboard BTC/USD feed exists on devnet", async () => {
      const accountInfo = await provider.connection.getAccountInfo(BTC_USD_FEED);
      expect(accountInfo).to.not.be.null;
      console.log("✅ BTC/USD feed account exists");
      console.log("   Owner:", accountInfo!.owner.toString());
      console.log("   Data size:", accountInfo!.data.length, "bytes");
    });

    it("Verifies Switchboard ETH/USD feed exists on devnet", async () => {
      const accountInfo = await provider.connection.getAccountInfo(ETH_USD_FEED);
      expect(accountInfo).to.not.be.null;
      console.log("✅ ETH/USD feed account exists");
      console.log("   Owner:", accountInfo!.owner.toString());
      console.log("   Data size:", accountInfo!.data.length, "bytes");
    });

    it("Verifies Switchboard SOL/USD feed exists on devnet", async () => {
      const accountInfo = await provider.connection.getAccountInfo(SOL_USD_FEED);
      expect(accountInfo).to.not.be.null;
      console.log("✅ SOL/USD feed account exists");
      console.log("   Owner:", accountInfo!.owner.toString());
      console.log("   Data size:", accountInfo!.data.length, "bytes");
    });
  });

  describe("Vault Integration with Real Switchboard Feeds", () => {
    let vaultPda: PublicKey;
    let vaultTokenMintPda: PublicKey;
    let userVaultTokenAccount: PublicKey;
    let vaultName: string;
    let btcAta: PublicKey;
    let ethAta: PublicKey;

    before(async () => {
      vaultName = `SwitchboardVault_${Date.now()}`;
      const assets = [
        { mint: btcMint, weight: 50, ata: PublicKey.default },
        { mint: ethMint, weight: 50, ata: PublicKey.default },
      ];

      vaultPda = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), admin.publicKey.toBuffer(), Buffer.from(vaultName)],
        program.programId
      )[0];

      vaultTokenMintPda = PublicKey.findProgramAddressSync(
        [Buffer.from("vault_mint"), admin.publicKey.toBuffer(), Buffer.from(vaultName)],
        program.programId
      )[0];

      btcAta = await getAssociatedTokenAddress(btcMint, vaultPda, true);
      ethAta = await getAssociatedTokenAddress(ethMint, vaultPda, true);

      console.log("\n🏗️  Creating vault with Switchboard integration...");
      
      await program.methods
        .createVault(vaultName, assets)
        .accounts({ admin: admin.publicKey })
        .remainingAccounts([
          { pubkey: btcMint, isWritable: false, isSigner: false },
          { pubkey: btcAta, isWritable: true, isSigner: false },
          { pubkey: ethMint, isWritable: false, isSigner: false },
          { pubkey: ethAta, isWritable: true, isSigner: false },
        ])
        .signers([admin])
        .rpc();

      console.log("✅ Vault created:", vaultPda.toString());

      // Fund user for testing
      const transferTx = await provider.connection.sendTransaction(
        new anchor.web3.Transaction().add(
          SystemProgram.transfer({
            fromPubkey: admin.publicKey,
            toPubkey: user.publicKey,
            lamports: 0.1 * anchor.web3.LAMPORTS_PER_SOL,
          })
        ),
        [admin]
      );
      await provider.connection.confirmTransaction(transferTx);

      userVaultTokenAccount = await getAssociatedTokenAddress(vaultTokenMintPda, user.publicKey);
    });

    it("Deposits SOL using real-time Switchboard price feeds", async () => {
      const depositAmount = 0.01 * anchor.web3.LAMPORTS_PER_SOL;

      console.log("\n💰 Testing deposit with real-time Switchboard prices...");
      console.log("   Deposit amount:", depositAmount / anchor.web3.LAMPORTS_PER_SOL, "SOL");

      const tx = await program.methods
        .depositMultiAsset(vaultName, new anchor.BN(depositAmount))
        .accountsStrict({
          vault: vaultPda,
          user: user.publicKey,
          userSharesAta: userVaultTokenAccount,
          vaultTokenMint: vaultTokenMintPda,
          btcQuote: BTC_USD_FEED,
          ethQuote: ETH_USD_FEED,
          solQuote: SOL_USD_FEED,
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
        ])
        .signers([user])
        .rpc({ skipPreflight: false });

      console.log("✅ Deposit successful!");
      console.log("   Transaction:", tx);

      // Verify shares minted
      const userShares = await getAccount(provider.connection, userVaultTokenAccount);
      expect(Number(userShares.amount)).to.be.greaterThan(0);
      console.log("   Shares minted:", userShares.amount.toString());
      console.log("\n🎉 Real-time Switchboard price integration working!");
    });
  });
});

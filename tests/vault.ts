import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { 
  TOKEN_PROGRAM_ID, 
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddress,
  createAssociatedTokenAccount,
  getMint,
} from "@solana/spl-token";
import { expect } from "chai";

describe("vault", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.Vault as Program<Vault>;
  const provider = anchor.getProvider();

  // Test accounts
  let authority: Keypair;
  let user1: Keypair;
  let user2: Keypair;
  let underlyingTokenMint: PublicKey;
  let vault: PublicKey;
  let vaultTokenMint: PublicKey;
  let user1VaultTokenAccount: PublicKey;
  let user2VaultTokenAccount: PublicKey;
  let user1UnderlyingTokenAccount: PublicKey;
  let user2UnderlyingTokenAccount: PublicKey;
  let vaultUnderlyingTokenAccount: PublicKey;

  before(async () => {
    // Create test keypairs
    authority = Keypair.generate();
    user1 = Keypair.generate();
    user2 = Keypair.generate();

    // Airdrop SOL to test accounts with confirmations
    const latestBlockhash = await provider.connection.getLatestBlockhash();
    
    const authorityAirdropSig = await provider.connection.requestAirdrop(authority.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction({
      signature: authorityAirdropSig,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });
    
    const user1AirdropSig = await provider.connection.requestAirdrop(user1.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction({
      signature: user1AirdropSig,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });
    
    const user2AirdropSig = await provider.connection.requestAirdrop(user2.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction({
      signature: user2AirdropSig,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });

    // Create underlying token mint for testing
    underlyingTokenMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    // Derive vault PDA
    [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), authority.publicKey.toBuffer()],
      program.programId
    );

    // Derive vault token mint PDA
    [vaultTokenMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_mint"), authority.publicKey.toBuffer()],
      program.programId
    );

    // Create associated token accounts
    user1VaultTokenAccount = await getAssociatedTokenAddress(
      vaultTokenMint,
      user1.publicKey
    );

    user2VaultTokenAccount = await getAssociatedTokenAddress(
      vaultTokenMint,
      user2.publicKey
    );

    user1UnderlyingTokenAccount = await getAssociatedTokenAddress(
      underlyingTokenMint,
      user1.publicKey
    );

    user2UnderlyingTokenAccount = await getAssociatedTokenAddress(
      underlyingTokenMint,
      user2.publicKey
    );

    // Note: vaultUnderlyingTokenAccount will be created by initializeSplVault
    // We can't create it here because vault is a PDA, not a valid token account owner
    // The initializeSplVault instruction will create this account

    // Create underlying token accounts for users
    await createAssociatedTokenAccount(
      provider.connection,
      authority,
      underlyingTokenMint,
      user1.publicKey
    );

    await createAssociatedTokenAccount(
      provider.connection,
      authority,
      underlyingTokenMint,
      user2.publicKey
    );

    // Mint underlying tokens to users
    await mintTo(
      provider.connection,
      authority,
      underlyingTokenMint,
      user1UnderlyingTokenAccount,
      authority,
      1000 * 10**6 // 1000 tokens with 6 decimals
    );

    await mintTo(
      provider.connection,
      authority,
      underlyingTokenMint,
      user2UnderlyingTokenAccount,
      authority,
      1000 * 10**6 // 1000 tokens with 6 decimals
    );
  });

  it("Initialize vault", async () => {
    const tx = await program.methods
      .initializeSplVault()
      .accounts({
        authority: authority.publicKey,
        underlyingAssetMint: underlyingTokenMint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    console.log("Initialize vault transaction signature", tx);

    // Verify vault was initialized correctly
    const vaultAccount = await program.account.vault.fetch(vault);
    expect(vaultAccount.authority.toString()).to.equal(authority.publicKey.toString());
    expect(vaultAccount.vaultTokenMint.toString()).to.equal(vaultTokenMint.toString());
    expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
    expect(vaultAccount.underlyingAssetMint.toString()).to.equal(underlyingTokenMint.toString());

    // Get the vault's underlying token account address
    // This account was created by initializeSplVault instruction
    // We need to derive it manually since vault is a PDA
    const [vaultUnderlyingTokenAccountPDA] = PublicKey.findProgramAddressSync(
      [
        vault.toBuffer(),
        TOKEN_PROGRAM_ID.toBuffer(),
        underlyingTokenMint.toBuffer(),
      ],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    vaultUnderlyingTokenAccount = vaultUnderlyingTokenAccountPDA;
  });

  it("User deposits tokens and receives correct shares", async () => {
    const depositAmount = 100 * 10**6; // 100 tokens with 6 decimals

    const tx = await program.methods
      .deposit(new anchor.BN(depositAmount))
      .accounts({
        vault: vault,
        vaultTokenMint: vaultTokenMint,
        user: user1.publicKey,
        userVaultTokenAccount: user1VaultTokenAccount,
        userUnderlyingTokenAccount: user1UnderlyingTokenAccount,
        vaultUnderlyingTokenAccount: vaultUnderlyingTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user1])
      .rpc();

    console.log("Deposit transaction signature", tx);

    // Verify user received shares (1:1 ratio for first deposit)
    const userVaultTokenAccountInfo = await getAccount(
      provider.connection,
      user1VaultTokenAccount
    );
    expect(userVaultTokenAccountInfo.amount.toString()).to.equal(depositAmount.toString());

    // Verify vault total assets increased
    const vaultAccount = await program.account.vault.fetch(vault);
    expect(vaultAccount.totalAssets.toNumber()).to.equal(depositAmount);
  });

  it("Multiple deposits maintain proportional shares", async () => {
    const firstDepositAmount = 100 * 10**6;
    const secondDepositAmount = 200 * 10**6;

    // First deposit by user1
    await program.methods
      .deposit(new anchor.BN(firstDepositAmount))
      .accounts({
        vault: vault,
        vaultTokenMint: vaultTokenMint,
        user: user1.publicKey,
        userVaultTokenAccount: user1VaultTokenAccount,
        userUnderlyingTokenAccount: user1UnderlyingTokenAccount,
        vaultUnderlyingTokenAccount: vaultUnderlyingTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user1])
      .rpc();

    // Second deposit by user2
    await program.methods
      .deposit(new anchor.BN(secondDepositAmount))
      .accounts({
        vault: vault,
        vaultTokenMint: vaultTokenMint,
        user: user2.publicKey,
        userVaultTokenAccount: user2VaultTokenAccount,
        userUnderlyingTokenAccount: user2UnderlyingTokenAccount,
        vaultUnderlyingTokenAccount: vaultUnderlyingTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user2])
      .rpc();

    // Get account info after both deposits
    const user1VaultTokenAccountInfo = await getAccount(
      provider.connection,
      user1VaultTokenAccount
    );
    const user2VaultTokenAccountInfo = await getAccount(
      provider.connection,
      user2VaultTokenAccount
    );
    const vaultAccount = await program.account.vault.fetch(vault);

    // User1 should have 100 shares (first deposit, 1:1 ratio)
    // Note: User1 already has 100M shares from previous test, so this adds another 100M
    const expectedUser1Shares = 100 * 10**6 + firstDepositAmount; // 100M + 100M = 200M
    expect(user1VaultTokenAccountInfo.amount.toString()).to.equal(expectedUser1Shares.toString());

    // User2 should have 200 shares (second deposit, 1:1 ratio since total was 100)
    expect(user2VaultTokenAccountInfo.amount.toString()).to.equal(secondDepositAmount.toString());

    // Total assets should be 500M (100M from first test + 100M + 200M from this test)
    const expectedTotalAssets = 100 * 10**6 + firstDepositAmount + secondDepositAmount; // 100M + 100M + 200M = 400M
    expect(vaultAccount.totalAssets.toNumber()).to.equal(expectedTotalAssets);
  });


  it("Deposit with 0 amount should fail", async () => {
    try {
      await program.methods
        .deposit(new anchor.BN(0))
        .accounts({
          vault: vault,
          vaultTokenMint: vaultTokenMint,
          user: user1.publicKey,
          userVaultTokenAccount: user1VaultTokenAccount,
          userUnderlyingTokenAccount: user1UnderlyingTokenAccount,
          vaultUnderlyingTokenAccount: vaultUnderlyingTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc();

      expect.fail("Expected transaction to fail");
    } catch (error) {
      expect(error.message).to.include("InvalidAmount");
    }
  });

  it("Proportional share calculation works correctly", async () => {
    // This test verifies that the vault maintains proper proportional accounting
    // when users deposit at different times with different amounts

    const vaultAccount = await program.account.vault.fetch(vault);
    const vaultTokenMintInfo = await getMint(provider.connection, vaultTokenMint);
    
    console.log("Final vault state:");
    console.log("- Total assets:", vaultAccount.totalAssets.toString());
    console.log("- Total supply:", vaultTokenMintInfo.supply.toString());
    console.log("- User1 shares:", (await getAccount(provider.connection, user1VaultTokenAccount)).amount.toString());
    console.log("- User2 shares:", (await getAccount(provider.connection, user2VaultTokenAccount)).amount.toString());

    // Verify that total supply equals sum of user shares
    const user1Shares = (await getAccount(provider.connection, user1VaultTokenAccount)).amount;
    const user2Shares = (await getAccount(provider.connection, user2VaultTokenAccount)).amount;
    const totalUserShares = user1Shares + user2Shares;
    
    expect(vaultTokenMintInfo.supply.toString()).to.equal(totalUserShares.toString());
  });

  // SOL Vault Tests
  describe("SOL Vault Tests", () => {
    let solVault: PublicKey;
    let solVaultTokenMint: PublicKey;
    let user1SolVaultTokenAccount: PublicKey;
    let user2SolVaultTokenAccount: PublicKey;

    before(async () => {
      // Derive SOL vault PDA
      [solVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), user1.publicKey.toBuffer()], // Use user1 as authority for SOL vault
        program.programId
      );

      // Derive SOL vault token mint PDA
      [solVaultTokenMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault_mint"), user1.publicKey.toBuffer()],
        program.programId
      );

      // Create associated token accounts for SOL vault
      user1SolVaultTokenAccount = await getAssociatedTokenAddress(
        solVaultTokenMint,
        user1.publicKey
      );

      user2SolVaultTokenAccount = await getAssociatedTokenAddress(
        solVaultTokenMint,
        user2.publicKey
      );
    });

    it("Initialize SOL vault", async () => {
      const tx = await program.methods
        .initializeSolVault()
        .accounts({
          authority: user1.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([user1])
        .rpc();

      console.log("Initialize SOL vault transaction signature", tx);

      // Verify SOL vault was initialized correctly
      const vaultAccount = await program.account.vault.fetch(solVault);
      expect(vaultAccount.authority.toString()).to.equal(user1.publicKey.toString());
      expect(vaultAccount.vaultTokenMint.toString()).to.equal(solVaultTokenMint.toString());
      expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
      expect(vaultAccount.underlyingAssetMint).to.be.null;
    });

    it("User deposits SOL and receives correct shares", async () => {
      const depositAmount = 1 * anchor.web3.LAMPORTS_PER_SOL; // 1 SOL

      const tx = await program.methods
        .deposit(new anchor.BN(depositAmount))
        .accounts({
          vault: solVault,
          vaultTokenMint: solVaultTokenMint,
          user: user1.publicKey,
          userVaultTokenAccount: user1SolVaultTokenAccount,
          userUnderlyingTokenAccount: null,
          vaultUnderlyingTokenAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc();

      console.log("SOL Deposit transaction signature", tx);

      // Verify user received shares (1:1 ratio for first deposit)
      const userVaultTokenAccountInfo = await getAccount(
        provider.connection,
        user1SolVaultTokenAccount
      );
      expect(userVaultTokenAccountInfo.amount.toString()).to.equal(depositAmount.toString());

      // Verify vault total assets increased
      const vaultAccount = await program.account.vault.fetch(solVault);
      expect(vaultAccount.totalAssets.toNumber()).to.equal(depositAmount);
    });
  });
});

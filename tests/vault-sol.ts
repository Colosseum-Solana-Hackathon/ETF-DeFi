import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Vault } from "../target/types/vault";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { 
  TOKEN_PROGRAM_ID, 
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { expect } from "chai";

describe("vault-sol", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.Vault as Program<Vault>;
  const provider = anchor.getProvider();

  // Test accounts
  let authority: Keypair;
  let user1: Keypair;
  let user2: Keypair;
  let vault: PublicKey;
  let vaultTokenMint: PublicKey;
  let user1VaultTokenAccount: PublicKey;
  let user2VaultTokenAccount: PublicKey;

  before(async () => {
    // Create test keypairs
    authority = Keypair.generate();
    user1 = Keypair.generate();
    user2 = Keypair.generate();

    // Airdrop SOL to test accounts
    await provider.connection.requestAirdrop(authority.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(user1.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(user2.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);

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
  });

  it("Initialize SOL vault", async () => {
    const tx = await program.methods
      .initializeVault(null) // null for SOL vault
      .accounts({
        vault: vault,
        authority: authority.publicKey,
        vaultTokenMint: vaultTokenMint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    console.log("Initialize SOL vault transaction signature", tx);

    // Verify vault was initialized correctly
    const vaultAccount = await program.account.vault.fetch(vault);
    expect(vaultAccount.authority.toString()).to.equal(authority.publicKey.toString());
    expect(vaultAccount.vaultTokenMint.toString()).to.equal(vaultTokenMint.toString());
    expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
    expect(vaultAccount.underlyingAssetMint).to.be.null;
  });

  it("User deposits SOL and receives correct shares", async () => {
    const depositAmount = 1 * anchor.web3.LAMPORTS_PER_SOL; // 1 SOL

    const tx = await program.methods
      .deposit(new anchor.BN(depositAmount))
      .accounts({
        vault: vault,
        vaultTokenMint: vaultTokenMint,
        user: user1.publicKey,
        userVaultTokenAccount: user1VaultTokenAccount,
        userUnderlyingTokenAccount: null,
        vaultUnderlyingTokenAccount: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user1])
      .rpc();

    console.log("Deposit SOL transaction signature", tx);

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

  it("Multiple SOL deposits maintain proportional shares", async () => {
    const firstDepositAmount = 1 * anchor.web3.LAMPORTS_PER_SOL;
    const secondDepositAmount = 2 * anchor.web3.LAMPORTS_PER_SOL;

    // First deposit by user1
    await program.methods
      .deposit(new anchor.BN(firstDepositAmount))
      .accounts({
        vault: vault,
        vaultTokenMint: vaultTokenMint,
        user: user1.publicKey,
        userVaultTokenAccount: user1VaultTokenAccount,
        userUnderlyingTokenAccount: null,
        vaultUnderlyingTokenAccount: null,
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
        userUnderlyingTokenAccount: null,
        vaultUnderlyingTokenAccount: null,
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

    // User1 should have 1 SOL worth of shares (first deposit, 1:1 ratio)
    expect(user1VaultTokenAccountInfo.amount.toString()).to.equal(firstDepositAmount.toString());

    // User2 should have 2 SOL worth of shares (second deposit, 1:1 ratio since total was 1 SOL)
    expect(user2VaultTokenAccountInfo.amount.toString()).to.equal(secondDepositAmount.toString());

    // Total assets should be 3 SOL
    expect(vaultAccount.totalAssets.toNumber()).to.equal(firstDepositAmount + secondDepositAmount);
  });

  it("User withdraws SOL shares and receives proportional SOL", async () => {
    const sharesToBurn = 0.5 * anchor.web3.LAMPORTS_PER_SOL; // 0.5 SOL worth of shares

    // Get initial balances
    const initialUserBalance = await provider.connection.getBalance(user1.publicKey);
    const initialVaultTotalAssets = (await program.account.vault.fetch(vault)).totalAssets;

    const tx = await program.methods
      .withdraw(new anchor.BN(sharesToBurn))
      .accounts({
        vault: vault,
        vaultTokenMint: vaultTokenMint,
        user: user1.publicKey,
        userVaultTokenAccount: user1VaultTokenAccount,
        userUnderlyingTokenAccount: null,
        vaultUnderlyingTokenAccount: null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user1])
      .rpc();

    console.log("Withdraw SOL transaction signature", tx);

    // Verify user's vault token balance decreased
    const userVaultTokenAccountInfo = await getAccount(
      provider.connection,
      user1VaultTokenAccount
    );
    const expectedRemainingShares = 1 * anchor.web3.LAMPORTS_PER_SOL - sharesToBurn; // 1 - 0.5 = 0.5
    expect(userVaultTokenAccountInfo.amount.toString()).to.equal(expectedRemainingShares.toString());

    // Verify user received SOL
    const finalUserBalance = await provider.connection.getBalance(user1.publicKey);
    const solReceived = finalUserBalance - initialUserBalance;
    expect(solReceived).to.equal(sharesToBurn); // 1:1 ratio for this test

    // Verify vault total assets decreased
    const finalVaultAccount = await program.account.vault.fetch(vault);
    expect(finalVaultAccount.totalAssets.toNumber()).to.equal(initialVaultTotalAssets.toNumber() - sharesToBurn);
  });
});

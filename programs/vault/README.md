# Vault Program

A Solana Anchor program that implements a base vault contract for handling deposits and withdrawals of assets (SOL and SPL tokens) with proportional share mechanics.

## Overview

The Vault program allows users to:
- Deposit assets (SOL or SPL tokens) and receive proportional vault shares
- Withdraw assets by burning vault shares
- Maintain accurate accounting of total assets under management
- Track user balances through vault share ownership

## Architecture

### Core Components

1. **Vault Account**: Stores vault state and configuration
2. **Vault Token Mint**: SPL token mint for vault shares
3. **Deposit/Withdraw Instructions**: Handle asset movements and share calculations

### Key Features

- **Proportional Share Mechanics**: Users receive shares proportional to their deposit relative to existing vault assets
- **SPL Token Integration**: Uses SPL tokens for vault shares with proper minting/burning
- **Access Control**: Only authorized instructions can move assets
- **Math Safety**: All calculations use checked arithmetic to prevent overflows
- **Comprehensive Error Handling**: Detailed error messages for edge cases

## Program Structure

```
programs/vault/src/
├── lib.rs          # Main program logic and instruction handlers
└── state.rs        # Account definitions and state management
```

## Instructions

### `initialize_vault`

Initializes a new vault with the specified authority and underlying asset.

**Accounts:**
- `vault` (PDA): The vault account to initialize
- `authority`: The authority that can manage the vault
- `vault_token_mint` (PDA): The mint for vault shares
- `system_program`: System program
- `token_program`: SPL Token program
- `rent`: Rent sysvar

**Parameters:**
- `underlying_asset_mint`: Optional underlying asset mint (None for SOL)

### `deposit`

Deposits assets into the vault and receives proportional shares.

**Accounts:**
- `vault`: The vault account
- `vault_token_mint`: The vault share mint
- `user`: The user making the deposit
- `user_vault_token_account`: User's vault token account
- `user_underlying_token_account`: User's underlying asset account (for SPL tokens)
- `vault_underlying_token_account`: Vault's underlying asset account (for SPL tokens)
- `token_program`: SPL Token program
- `associated_token_program`: Associated Token program
- `system_program`: System program

**Parameters:**
- `amount`: Amount of assets to deposit

### `withdraw`

Withdraws assets from the vault by burning shares.

**Accounts:**
- `vault`: The vault account
- `vault_token_mint`: The vault share mint
- `user`: The user making the withdrawal
- `user_vault_token_account`: User's vault token account
- `user_underlying_token_account`: User's underlying asset account (for SPL tokens)
- `vault_underlying_token_account`: Vault's underlying asset account (for SPL tokens)
- `token_program`: SPL Token program

**Parameters:**
- `shares_to_burn`: Number of shares to burn

## Share Calculation

The vault uses proportional share mechanics:

1. **First Deposit**: 1:1 ratio (amount = shares)
2. **Subsequent Deposits**: `shares = (amount * total_supply) / total_assets`
3. **Withdrawals**: `assets = (shares * total_assets) / total_supply`

## Error Handling

The program includes comprehensive error handling:

- `InvalidAmount`: Deposit/withdraw amount must be > 0
- `InsufficientShares`: User doesn't have enough shares to burn
- `InsufficientAssets`: Vault doesn't have enough assets to withdraw
- `MathOverflow`: Arithmetic operation would overflow
- `InvalidUnderlyingAsset`: Mismatched underlying asset

## Testing

The program includes comprehensive tests covering:

- Basic deposit/withdraw functionality
- Proportional share calculations
- Multiple user scenarios
- Edge cases (insufficient balance, zero amounts)
- Both SOL and SPL token scenarios

### Running Tests

```bash
# Run all vault tests
anchor test

# Run specific test files
anchor test tests/vault.ts
anchor test tests/vault-sol.ts
```

## Usage Examples

### Initialize a SOL Vault

```typescript
await program.methods
  .initializeVault(null) // null for SOL vault
  .accounts({
    vault: vaultPDA,
    authority: authority.publicKey,
    vaultTokenMint: vaultTokenMintPDA,
    systemProgram: SystemProgram.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
    rent: SYSVAR_RENT_PUBKEY,
  })
  .signers([authority])
  .rpc();
```

### Initialize an SPL Token Vault

```typescript
await program.methods
  .initializeVault(underlyingTokenMint)
  .accounts({
    vault: vaultPDA,
    authority: authority.publicKey,
    vaultTokenMint: vaultTokenMintPDA,
    systemProgram: SystemProgram.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
    rent: SYSVAR_RENT_PUBKEY,
  })
  .signers([authority])
  .rpc();
```

### Deposit Assets

```typescript
await program.methods
  .deposit(new anchor.BN(amount))
  .accounts({
    vault: vaultPDA,
    vaultTokenMint: vaultTokenMintPDA,
    user: user.publicKey,
    userVaultTokenAccount: userVaultTokenAccount,
    userUnderlyingTokenAccount: userUnderlyingTokenAccount, // for SPL tokens
    vaultUnderlyingTokenAccount: vaultUnderlyingTokenAccount, // for SPL tokens
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .signers([user])
  .rpc();
```

### Withdraw Assets

```typescript
await program.methods
  .withdraw(new anchor.BN(sharesToBurn))
  .accounts({
    vault: vaultPDA,
    vaultTokenMint: vaultTokenMintPDA,
    user: user.publicKey,
    userVaultTokenAccount: userVaultTokenAccount,
    userUnderlyingTokenAccount: userUnderlyingTokenAccount, // for SPL tokens
    vaultUnderlyingTokenAccount: vaultUnderlyingTokenAccount, // for SPL tokens
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([user])
  .rpc();
```

## Security Considerations

1. **Access Control**: Only the vault authority can initialize the vault
2. **Math Safety**: All arithmetic operations use checked math to prevent overflows
3. **Account Validation**: Proper constraints ensure accounts are valid and authorized
4. **Share Integrity**: Shares are minted/burned atomically with asset transfers

## Future Enhancements

- Strategy integration for yield generation
- Fee mechanisms for vault management
- Emergency pause functionality
- Multi-asset vault support
- Governance mechanisms for vault parameters

## License

This program is part of the ETF DeFi project and follows the project's licensing terms.

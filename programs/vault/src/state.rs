use anchor_lang::prelude::*;

/// Vault account that stores the vault's state and configuration
#[account]
pub struct Vault {
    /// The authority that can manage this vault
    pub authority: Pubkey,
    /// The mint for vault shares (SPL token)
    pub vault_token_mint: Pubkey,
    /// Total assets under management (in lamports for SOL, or token amount for SPL tokens)
    pub total_assets: u64,
    /// The underlying asset mint (None for SOL, Some(mint) for SPL tokens)
    pub underlying_asset_mint: Option<Pubkey>,
    /// Optional strategy PDA for delegated asset management
    pub strategy: Option<Pubkey>,
    /// Bump seed for the vault PDA
    pub bump: u8,
}

impl Vault {
    /// Space required for the Vault account
    /// On Solana, you must allocate exact byte size when creating an account (because rent depends on size).
    pub const SPACE: usize = 8 + // discriminator
        32 + // authority
        32 + // vault_token_mint
        8 +  // total_assets
        1 + 32 + // underlying_asset_mint (Option<Pubkey>)
        1 + 32 + // strategy (Option<Pubkey>)
        1;   // bump

    /// Create a new vault instance
    pub fn new(
        authority: Pubkey,
        vault_token_mint: Pubkey,
        underlying_asset_mint: Option<Pubkey>,
        strategy: Option<Pubkey>,
        bump: u8,
    ) -> Self {
        Self {
            authority,
            vault_token_mint,
            total_assets: 0,
            underlying_asset_mint,
            strategy,
            bump,
        }
    }

    /// Update total assets (only callable by the vault authority)
    pub fn update_total_assets(&mut self, new_total: u64) {
        self.total_assets = new_total;
    }
}

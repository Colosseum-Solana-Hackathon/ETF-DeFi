use anchor_lang::prelude::*;

/// Multi-asset vault account that stores composition, shares, and asset allocations
/// This is the core PDA for each unique vault instance
#[account]
pub struct Vault {
    /// Bump seed for the vault PDA
    pub bump: u8,
    /// Admin/authority that can manage this vault (rebalance, update composition, etc.)
    pub admin: Pubkey,
    /// Unique vault identifier/name (e.g., "MVPVault", "AggressiveGrowth")
    /// Max 32 bytes to keep space reasonable
    pub name: String,
    /// SPL mint for vault shares (each vault has unique shares)
    pub vault_token_mint: Pubkey,
    /// Basket composition: array of assets with weights and ATAs
    /// Vec is dynamic but we need to account for max size in space calculation
    pub assets: Vec<AssetConfig>,
    /// Optional Marinade strategy PDA for SOL staking
    /// Stored at vault level since each vault may have its own strategy state
    pub marinade_strategy: Option<Pubkey>,
}

/// Asset configuration within a vault's composition
/// Defines each asset in the basket with its weight and storage account
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct AssetConfig {
    /// Asset mint (e.g., wBTC, wETH, SOL wrapped mint, or native SOL placeholder)
    pub mint: Pubkey,
    /// Allocation weight as percentage (e.g., 40 = 40%)
    /// Sum of all weights in vault.assets must equal 100
    pub weight: u8,
    /// Vault's Associated Token Account for this asset
    /// Stores the actual tokens for this asset
    pub ata: Pubkey,
}

impl Vault {
    /// Calculate space required for a Vault account
    /// This is critical for Solana's rent-exemption model
    /// 
    /// Space breakdown:
    /// - 8 bytes: Anchor account discriminator (identifies account type)
    /// - 1 byte: bump seed
    /// - 32 bytes: admin pubkey
    /// - 4 bytes: String length prefix for name
    /// - name.len() bytes: actual name string
    /// - 32 bytes: vault_token_mint pubkey
    /// - 4 bytes: Vec length prefix for assets
    /// - assets.len() * 65 bytes: each AssetConfig (32 + 1 + 32)
    /// - 1 + 32 bytes: Option<Pubkey> for marinade_strategy
    pub fn space(name_len: usize, num_assets: usize) -> usize {
        8 +  // discriminator
        1 +  // bump
        32 + // admin
        4 + name_len + // name (String with length prefix)
        32 + // vault_token_mint
        4 + (num_assets * (32 + 1 + 32)) + // assets Vec (mint + weight + ata per asset)
        1 + 32 // marinade_strategy Option<Pubkey>
    }

    /// Validate that asset weights sum to 100%
    /// This is a core invariant for proper allocation
    pub fn validate_weights(&self) -> Result<()> {
        let total_weight: u64 = self.assets.iter().map(|a| a.weight as u64).sum();
        require!(total_weight == 100, crate::VaultError::InvalidWeights);
        Ok(())
    }

    /// Get asset config by mint pubkey
    /// Useful for lookups during deposit/withdraw/rebalance
    pub fn get_asset_by_mint(&self, mint: &Pubkey) -> Option<&AssetConfig> {
        self.assets.iter().find(|a| &a.mint == mint)
    }

    /// Update total assets (only callable by the vault authority)
    pub fn update_total_assets(&mut self, _new_total: u64) {
        // This method is preserved for backward compatibility
        // In multi-asset vaults, TVL is calculated on-demand from asset ATAs
        msg!("Warning: update_total_assets is deprecated for multi-asset vaults");
    }

    /// Calculate total value locked (TVL) in USD micro-dollars
    /// This is a simplified mock calculation for devnet
    pub fn calculate_tvl(
        &self,
        _btc_price: &crate::NormalizedPrice,
        _eth_price: &crate::NormalizedPrice,
        _sol_price: &crate::NormalizedPrice,
    ) -> Option<i64> {
        // In production, this would:
        // 1. Fetch balances from each asset's ATA
        // 2. Multiply by current prices
        // 3. Sum all values
        // For now, return None to use fallback logic
        None
    }
}

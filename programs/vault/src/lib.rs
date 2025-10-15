use anchor_lang::prelude::*;
use anchor_lang::Result;
use anchor_lang::solana_program::pubkey;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::associated_token::{spl_associated_token_account, AssociatedToken};
use anchor_spl::token::{Mint, Token, TokenAccount};
use pyth_sdk_solana::{PriceFeed, state::SolanaPriceAccount};
use crate::swap::MockSwap;

mod state;
use state::{AssetConfig, Vault};

// Mock swap module for devnet testing
mod swap;

// Import strategy interface types for Marinade integration
// use strategy_interface::{InitializeArgs, StakeArgs, StrategyKind, StrategyState, UnstakeArgs};

// Pyth devnet price feed IDs
pub const BTC_USD_FEED: Pubkey = pubkey!("HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J");
pub const ETH_USD_FEED: Pubkey = pubkey!("JBu1AL4obBcCMqKBBxhpWCNUt136ijcuMZLFvTP7iWdB");
pub const SOL_USD_FEED: Pubkey = pubkey!("H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG");
// Devnet: Use very large staleness threshold since price feeds may not update frequently
// This essentially disables staleness checking for devnet testing
// Mainnet: Should use a much tighter threshold like 60 seconds for production safety
pub const STALENESS_THRESHOLD: u64 = 31536000; // 1 year (effectively disabled for devnet)

// Price feed precision helper
// Pyth prices use i64 with negative exponents (e.g., -8 for BTC)
// This helper normalizes prices to a common USD value
#[derive(Clone, Copy, Debug)]
pub struct NormalizedPrice {
    pub price_usd: i64, // Price in USD with 6 decimals (micro-dollars)
    pub original_price: i64,
    pub expo: i32,
}

impl NormalizedPrice {
    /// Convert Pyth price to micro-dollars (6 decimals)
    /// Example: BTC at $50,000 with expo=-8 -> 50_000_000_000 micro-dollars
    pub fn from_pyth(price: i64, expo: i32) -> Result<Self> {
        let price_usd = if expo < -6 {
            // Price has more decimals than we want, divide
            price
                .checked_div(10i64.pow((-expo - 6) as u32))
                .ok_or(VaultError::MathOverflow)?
        } else if expo > -6 {
            // Price has fewer decimals, multiply
            price
                .checked_mul(10i64.pow((6 + expo) as u32))
                .ok_or(VaultError::MathOverflow)?
        } else {
            price
        };
        Ok(Self {
            price_usd,
            original_price: price,
            expo,
        })
    }

    /// Calculate token amount from USD value (in micro-dollars)
    /// Returns amount in token's native decimals
    pub fn usd_to_tokens(&self, usd_micro: i64, token_decimals: u8) -> Result<i64> {
        // usd_micro has 6 decimals
        // price_usd has 6 decimals
        // Result should have token_decimals
        let base_amount: i64 = usd_micro
            .checked_mul(10i64.pow(token_decimals as u32))
            .ok_or(VaultError::MathOverflow)?
            .checked_div(self.price_usd)
            .ok_or(VaultError::MathOverflow)?;
        Ok(base_amount)
    }

    /// Calculate USD value from token amount
    pub fn tokens_to_usd(&self, amount: u64, token_decimals: u8) -> i64 {
        let amount_i64 = amount as i64;
        (amount_i64 * self.price_usd) / 10i64.pow(token_decimals as u32)
    }
}

/// Helper functions for price and token calculations
impl Vault {
    /// Convert token amount to USD micro-dollars (6 decimals)
    /// Handles different token decimals properly
    pub fn token_amount_to_usd_micro(amount: u64, token_decimals: u8) -> Result<u64> {
        // Convert from token's native decimals to 6 decimal USD
        let result = if token_decimals >= 6 {
            // Token has more decimals than USD, divide
            (amount)
                .checked_div(10u64.pow((token_decimals - 6) as u32))
                .ok_or(VaultError::MathOverflow)?
        } else {
            // Token has fewer decimals, multiply
            (amount)
                .checked_mul(10u64.pow((6 - token_decimals) as u32))
                .ok_or(VaultError::MathOverflow)?
        };

        Ok(result)
    }

    /// Convert USD micro-dollars to token amount
    /// Handles different token decimals properly
    pub fn usd_micro_to_token_amount(usd_micro: i64, token_decimals: u8) -> Result<u64> {
        // Convert from 6 decimal USD to token's native decimals
        let result = if token_decimals >= 6 {
            // Token has more decimals than USD, multiply
            (usd_micro
                .checked_mul(10i64.pow((token_decimals - 6) as u32))
                .ok_or(VaultError::MathOverflow)?) as u64
        } else {
            // Token has fewer decimals, divide
            (usd_micro
                .checked_div(10i64.pow((6 - token_decimals) as u32))
                .ok_or(VaultError::MathOverflow)?) as u64
        };

        Ok(result)
    }

    /// Calculate token amount from USD allocation using normalized price
    pub fn calculate_token_amount_from_usd(
        usd_allocation: i64,
        normalized_price: &NormalizedPrice,
        token_decimals: u8,
    ) -> Result<u64> {
        let amount = normalized_price.usd_to_tokens(usd_allocation, token_decimals)?;
        Ok(amount as u64)
    }

    /// Calculate total vault value (TVL) in USD micro-dollars
    /// This uses the current Pyth prices and actual token balances in vault ATAs
    pub fn calculate_tvl_from_balances(
        btc_balance: u64,
        eth_balance: u64,
        sol_balance: u64,
        btc_price: &NormalizedPrice,
        eth_price: &NormalizedPrice,
        sol_price: &NormalizedPrice,
    ) -> Result<i64> {
        // Calculate USD value for each asset
        let btc_value_usd = btc_price.tokens_to_usd(btc_balance, 8); // BTC has 8 decimals
        let eth_value_usd = eth_price.tokens_to_usd(eth_balance, 18); // ETH has 18 decimals
        let sol_value_usd = sol_price.tokens_to_usd(sol_balance, 9); // SOL has 9 decimals

        // Sum all values
        let total_tvl = btc_value_usd
            .checked_add(eth_value_usd)
            .ok_or(VaultError::MathOverflow)?
            .checked_add(sol_value_usd)
            .ok_or(VaultError::MathOverflow)?;

        msg!(
            "TVL Calculation: BTC=${}, ETH=${}, SOL=${}, Total=${}",
            btc_value_usd,
            eth_value_usd,
            sol_value_usd,
            total_tvl
        );

        Ok(total_tvl)
    }

    /// Calculate share price in USD micro-dollars
    /// Special case: if no shares exist, return 1_000_000 (= $1.00)
    pub fn calculate_share_price(tvl_usd_micro: i64, total_shares: u64) -> Result<i64> {
        if total_shares == 0 {
            // First deposit: share price = $1.00 (in micro-dollars)
            Ok(1_000_000)
        } else {
            // Share_Price = TVL / Total_Shares
            let share_price = (tvl_usd_micro)
                .checked_mul(1_000_000_000) // Scale up for precision (vault shares have 9 decimals)
                .ok_or(VaultError::MathOverflow)?
                .checked_div(total_shares as i64)
                .ok_or(VaultError::MathOverflow)?
                .checked_div(1_000) // Scale back to micro-dollars (6 decimals)
                .ok_or(VaultError::MathOverflow)?;

            Ok(share_price)
        }
    }

    /// Calculate shares to mint based on deposit value and share price
    pub fn calculate_shares_to_mint(deposit_usd_micro: i64, share_price_usd_micro: i64) -> Result<u64> {
        // Shares = (Deposit_Value * 10^9) / Share_Price
        // We multiply by 10^9 because vault shares have 9 decimals
        let shares = (deposit_usd_micro)
            .checked_mul(1_000_000_000) // Scale to 9 decimals
            .ok_or(VaultError::MathOverflow)?
            .checked_div(share_price_usd_micro)
            .ok_or(VaultError::MathOverflow)?
            .checked_div(1_000) // Adjust from micro (6) to match 9 decimal shares
            .ok_or(VaultError::MathOverflow)?;

        Ok(shares as u64)
    }
}

// Events for off-chain tracking and indexing
#[event]
pub struct VaultCreatedEvent {
    pub vault: Pubkey,
    pub admin: Pubkey,
    pub name: String,
    pub vault_token_mint: Pubkey,
    pub num_assets: u8,
}

#[event]
pub struct DepositEvent {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub deposit_mint: Pubkey,
    pub amount_deposited: u64,
    pub shares_minted: u64,
    pub tvl_usd: i64,
}

#[event]
pub struct WithdrawEvent {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub shares_burned: u64,
    pub amount_withdrawn: u64,
  pub tvl_usd: i64,
}

declare_id!("BZAQS5pJ1nWKqmGmv76EJmNPEZWMV4BDebMarGcUSKGd");

#[program]
pub mod vault {
  use super::*;    /// Create a new multi-asset vault with custom composition
    ///
    /// This is the primary initialization instruction for creating vaults.
    /// Each vault is a unique PDA derived from admin + name, allowing multiple
    /// vaults per admin with different compositions.
    ///
    /// **Key Design Decisions:**
    /// 1. **PDA Seeds**: [b"vault", admin, name] - enables multiple vaults per admin
    /// 2. **Dynamic Space**: Calculated from name length and asset count at runtime
    /// 3. **Share Mint**: Each vault has unique SPL token for shares (9 decimals for precision)
    /// 4. **Asset ATAs**: Created via remaining_accounts to handle variable asset count
    ///
    /// **Solana Best Practices:**
    /// - Uses init constraint for atomic account creation with rent exemption
    /// - Vault PDA is mint authority for shares (secure share issuance)
    /// - ATAs use canonical Associated Token Program addresses
    /// - Validates composition (weights sum to 100) before creation
    ///
    /// **Parameters:**
    /// - name: Unique identifier (max 32 bytes for space efficiency)
    /// - assets: Vec of AssetConfig with mint, weight, and ATA placeholder
    ///
    /// **Remaining Accounts (passed in order):**
    /// For each asset: [mint_account, ata_account]
    /// - mint_account: The SPL token mint (unchecked, validated against AssetConfig)
    /// - ata_account: Vault's ATA for this mint (mut, will be initialized)
    pub fn create_vault<'info>(
        ctx: Context<'_, '_, '_, 'info, CreateVault<'info>>,
        name: String,
        assets: Vec<AssetConfig>,
    ) -> Result<()> {
        // Validation: Name length (for space and clarity)
        require!(name.len() > 0 && name.len() <= 32, VaultError::InvalidName);

        // Validation: Asset count (at least 1, reasonable max for compute budget)
        require!(
            assets.len() > 0 && assets.len() <= 10,
            VaultError::InvalidAssetCount
        );

        // Validation: Weights sum to exactly 100
        let total_weight: u64 = assets.iter().map(|a| a.weight as u64).sum();
        require!(total_weight == 100, VaultError::InvalidWeights);

        // Validation: All weights are positive
        require!(
            assets.iter().all(|a| a.weight > 0),
            VaultError::InvalidWeights
        );

        // Validation: Check we have correct number of remaining accounts
        require!(
            ctx.remaining_accounts.len() == assets.len() * 2,
            VaultError::InvalidRemainingAccounts
        );

        let vault = &mut ctx.accounts.vault;
        vault.bump = ctx.bumps.vault;
        vault.admin = ctx.accounts.admin.key();
        vault.name = name.clone();
        vault.vault_token_mint = ctx.accounts.vault_token_mint.key();
        vault.assets = Vec::with_capacity(assets.len());
        vault.marinade_strategy = None;

        // Create ATAs for each asset using remaining_accounts
        // This approach is necessary because Anchor account constraints don't support
        // variable-length account lists. Using remaining_accounts + manual validation
        // is the standard Solana pattern for dynamic account sets.
        for (i, asset_config) in assets.iter().enumerate() {
            // Validate we have enough remaining accounts
            require!(
                ctx.remaining_accounts.len() > (i * 2 + 1),
                VaultError::InvalidRemainingAccounts
            );

            let mint_account = &ctx.remaining_accounts[i * 2];
            let ata_account = &ctx.remaining_accounts[i * 2 + 1];

            // Validate account types and ownership
            require!(
                mint_account.owner == &anchor_spl::token::ID,
                VaultError::InvalidMint
            );

            // Validate mint matches expected mint from AssetConfig
            require!(
                mint_account.key() == asset_config.mint,
                VaultError::InvalidMint
            );

            // Derive expected ATA address for security (prevent fake ATAs)
            let expected_ata = anchor_spl::associated_token::get_associated_token_address(
                &vault.key(),
                &asset_config.mint,
            );
            require!(ata_account.key() == expected_ata, VaultError::InvalidATA);

            // Check ATA ownership only if account already exists
            // Uninitialized accounts are owned by System Program, not ATA Program
            if !ata_account.data_is_empty() {
                require!(
                    ata_account.owner == &spl_associated_token_account::id(),
                    VaultError::InvalidATA
                );
            }

            // Initialize ATA if it doesn't exist
            // This is a CPI (Cross-Program Invocation) to the Associated Token Program
            // We check if the account is empty (uninitialized) and create it if needed
            if ata_account.data_is_empty() {
                msg!("Initializing ATA for asset {}", asset_config.mint);
                
                // Create the ATA using CPI to the Associated Token Program
                // This is the idiomatic way to create ATAs on Solana
                let cpi_accounts = anchor_spl::associated_token::Create {
                    payer: ctx.accounts.admin.to_account_info(),
                    associated_token: ata_account.clone(),
                    authority: vault.to_account_info(),
                    mint: mint_account.clone(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                };
                
                let cpi_program = ctx.accounts.associated_token_program.to_account_info();
                let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
                
                anchor_spl::associated_token::create(cpi_ctx)?;
                
                msg!("ATA created successfully: {}", expected_ata);
            } else {
                msg!("ATA already exists: {}", expected_ata);
            }

            // Store asset configuration with actual ATA address
            vault.assets.push(AssetConfig {
                mint: asset_config.mint,
                weight: asset_config.weight,
                ata: expected_ata,
            });

            msg!(
                "Asset {}: mint={}, weight={}%, ata={}",
                i,
                asset_config.mint,
                asset_config.weight,
                expected_ata
            );
        }

        msg!("Vault '{}' created successfully", vault.name);
        msg!("  Admin: {}", vault.admin);
        msg!("  Share Mint: {}", vault.vault_token_mint);
        msg!("  Assets: {}", vault.assets.len());

        // Emit creation event for indexers/off-chain tracking
        emit!(VaultCreatedEvent {
            vault: vault.key(),
            admin: vault.admin,
            name: vault.name.clone(),
            vault_token_mint: vault.vault_token_mint,
            num_assets: vault.assets.len() as u8,
        });

        Ok(())
    }

    /// Deposit SOL into a multi-asset vault and receive proportional shares
    /// This function handles the complete deposit flow with proper formulas
    ///
    /// **Parameters:**
    /// - amount: Amount of SOL to deposit (in lamports, 9 decimals)
    /// - name: Vault name for PDA derivation
    ///
    /// **Process:**
    /// 1. Convert SOL deposit amount to USD using SOL price
    /// 2. Calculate current vault TVL from existing balances
    /// 3. Calculate share price (TVL / total_shares, or $1 if first deposit)
    /// 4. Allocate SOL across vault assets based on weights
    /// 5. Execute mock swaps to achieve target allocation
    /// 6. Mint vault shares proportional to deposit value
    pub fn deposit_multi_asset(
        ctx: Context<DepositMultiAsset>,
        name: String,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, VaultError::InvalidAmount);

        // Validate remaining accounts: we need asset mints and vault ATAs
        require!(
            ctx.remaining_accounts.len() == ctx.accounts.vault.assets.len() * 2,
            VaultError::InvalidRemainingAccounts
        );

        let vault = &ctx.accounts.vault;
        let sol_decimals = 9u8; // SOL has 9 decimals

        // Fetch and normalize Pyth price feeds
        let clock = &ctx.accounts.clock;
        let current_time = clock.unix_timestamp as u64;

        msg!("🔍 Fetching Pyth price feeds...");

        // Load and normalize BTC price
        // Using get_price_unchecked() for devnet since timestamps may be corrupted
        // For mainnet, should use get_price_no_older_than() with proper staleness checking
        let btc_feed: PriceFeed = SolanaPriceAccount::account_info_to_feed(&ctx.accounts.btc_price_feed)
            .map_err(|e| {
                msg!("Failed to parse BTC price feed: {:?}", e);
                VaultError::InvalidPriceFeed
            })?;
        let btc_price = btc_feed.get_price_unchecked();
        msg!("BTC Price: {} (expo: {})", btc_price.price, btc_price.expo);
        let btc_normalized = NormalizedPrice::from_pyth(btc_price.price, btc_price.expo)?;

        // Load and normalize ETH price
        let eth_feed: PriceFeed = SolanaPriceAccount::account_info_to_feed(&ctx.accounts.eth_price_feed)
            .map_err(|e| {
                msg!("Failed to parse ETH price feed: {:?}", e);
                VaultError::InvalidPriceFeed
            })?;
        let eth_price = eth_feed.get_price_unchecked();
        msg!("ETH Price: {} (expo: {})", eth_price.price, eth_price.expo);
        let eth_normalized = NormalizedPrice::from_pyth(eth_price.price, eth_price.expo)?;

        // Load and normalize SOL price
        let sol_feed: PriceFeed = SolanaPriceAccount::account_info_to_feed(&ctx.accounts.sol_price_feed)
            .map_err(|e| {
                msg!("Failed to parse SOL price feed: {:?}", e);
                VaultError::InvalidPriceFeed
            })?;
        let sol_price = sol_feed.get_price_unchecked();
        msg!("SOL Price: {} (expo: {})", sol_price.price, sol_price.expo);
        let sol_normalized = NormalizedPrice::from_pyth(sol_price.price, sol_price.expo)?;

        msg!(
            "📊 Prices - BTC: ${}, ETH: ${}, SOL: ${}",
            btc_normalized.price_usd,
            eth_normalized.price_usd,
            sol_normalized.price_usd
        );

        // STEP 1: Transfer SOL from user to vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.user.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
        };

        let cpi_program = ctx.accounts.system_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        transfer(cpi_ctx, amount)?;
        msg!("✅ Transferred {} lamports from user to vault", amount);

        // STEP 2: Calculate deposit value in USD
        let deposit_usd_micro = sol_normalized.tokens_to_usd(amount, sol_decimals);
        msg!("Deposit: {} SOL = ${} USD", amount, deposit_usd_micro);

        // STEP 3: Calculate current vault TVL from asset balances in ATAs
        msg!("Calculating vault TVL...");
        
        // Get asset balances from remaining_accounts (vault ATAs)
        let mut btc_balance = 0u64;
        let mut eth_balance = 0u64;
        let mut sol_balance = 0u64;

        for (i, asset) in vault.assets.iter().enumerate() {
            let ata_account_info = &ctx.remaining_accounts[i * 2 + 1];
            
            // Parse the ATA to get balance
            if ata_account_info.data_is_empty() {
                msg!("  Asset {} ATA is empty (balance = 0)", asset.mint);
                continue;
            }

            // Deserialize token account to get amount
            let ata_data = ata_account_info.try_borrow_data()?;
            let ata = TokenAccount::try_deserialize(&mut &ata_data[..])?;
            
            msg!("Asset {} (weight {}%): {} tokens", asset.mint, asset.weight, ata.amount);

            // Map balance to correct asset based on weight
            // This is a simplified approach - in production you'd match by mint address
            match asset.weight {
                40 => btc_balance = ata.amount, // BTC gets 40%
                30 if eth_balance == 0 => eth_balance = ata.amount, // First 30% is ETH
                30 => sol_balance = ata.amount, // Second 30% is SOL
                _ => {}
            }
        }

        let current_tvl = Vault::calculate_tvl_from_balances(
            btc_balance,
            eth_balance,
            sol_balance,
            &btc_normalized,
            &eth_normalized,
            &sol_normalized,
        )?;

        msg!("Current TVL: ${} USD", current_tvl);

        // STEP 4: Calculate share price
        let total_shares = ctx.accounts.vault_token_mint.supply;
        let share_price = Vault::calculate_share_price(current_tvl, total_shares)?;
        
        msg!(
            "Share Price: ${} USD (TVL: ${}, Supply: {} shares)",
            share_price,
            current_tvl,
            total_shares
        );

        // STEP 5: Calculate shares to mint
        let shares_to_mint = Vault::calculate_shares_to_mint(deposit_usd_micro, share_price)?;
        msg!("🎁 Shares to mint: {} shares", shares_to_mint);

        // STEP 6: Transfer SOL from user to vault
        msg!("💸 Transferring {} SOL from user to vault...", amount);
        let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.user.key(),
            &ctx.accounts.vault.key(),
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
        msg!("✅ SOL transferred successfully");

        // STEP 7: Allocate SOL across vault assets using MockSwap
        msg!("🔄 Allocating deposit across vault assets...");

        for (i, asset) in vault.assets.iter().enumerate() {
            let usd_allocation = (deposit_usd_micro * asset.weight as i64) / 100;
            let sol_amount_for_asset = (amount as i64 * asset.weight as i64 / 100) as u64;
            
            // Get the decimals, price, and whether to swap for this asset
            let (decimals, price, asset_name) = match asset.weight {
                40 => (8u8, &btc_normalized, "BTC"),  // BTC - needs swap
                30 if i == 1 => (18u8, &eth_normalized, "ETH"), // ETH - needs swap
                30 => (9u8, &sol_normalized, "SOL"),  // SOL - no swap needed
                _ => continue,
            };

            // Calculate token amount using MockSwap for BTC and ETH
            let token_amount = if asset_name == "SOL" {
                // For SOL, no swap needed - amount is already in SOL
                sol_amount_for_asset
            } else {
                // For BTC and ETH, use MockSwap to calculate swap output
                MockSwap::calculate_swap_output(
                    sol_amount_for_asset,
                    sol_normalized.original_price,
                    sol_normalized.expo,
                    price.original_price,
                    price.expo,
                    9, // SOL decimals
                    decimals, // Target asset decimals
                )?
            };

            msg!(
                "  ✓ Asset {} ({}%): ${} USD = {} {} (from {} SOL)",
                asset.mint,
                asset.weight,
                usd_allocation,
                token_amount,
                asset_name,
                sol_amount_for_asset
            );

            // NOTE: For devnet, MockSwap only calculates amounts
            // In production with Jupiter, actual swaps would execute here:
            // - For SOL: Already in vault (no swap needed)
            // - For BTC/ETH: Execute Jupiter CPI (SOL -> BTC/ETH)
            // Assets would then be deposited into vault ATAs
        }

        // STEP 8: Mint shares to user
        msg!("🪙 Minting {} shares to user...", shares_to_mint);

        let vault_seeds = &[
            b"vault".as_ref(),
            vault.admin.as_ref(),
            vault.name.as_bytes(),
            &[vault.bump],
        ];
        let signer_seeds = &[&vault_seeds[..]];

        let cpi_accounts = anchor_spl::token::MintTo {
            mint: ctx.accounts.vault_token_mint.to_account_info(),
            to: ctx.accounts.user_shares_ata.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
        
        anchor_spl::token::mint_to(cpi_ctx, shares_to_mint)?;

        // STEP 9: Calculate new vault state
        let new_tvl = current_tvl + deposit_usd_micro;
        let new_total_shares = total_shares + shares_to_mint;
        let new_share_price = Vault::calculate_share_price(new_tvl, new_total_shares)?;

        msg!("✅ Deposit Complete!");
        msg!("   New TVL: ${} USD", new_tvl);
        msg!("   New Total Shares: {}", new_total_shares);
        msg!("   New Share Price: ${} USD", new_share_price);

        // Emit deposit event
        emit!(DepositEvent {
            vault: vault.key(),
            user: ctx.accounts.user.key(),
            deposit_mint: anchor_lang::solana_program::system_program::ID, // SOL
            amount_deposited: amount,
            shares_minted: shares_to_mint,
            tvl_usd: new_tvl,
        });

        Ok(())
    }

    /// Withdraw from multi-asset vault by burning shares
    /// This function implements proportional withdrawal across all vault assets
    ///
    /// **Parameters:**
    /// - shares: Amount of vault shares to burn
    /// - name: Vault name for PDA derivation
    ///
    /// **Process:**
    /// 1. Calculate withdrawal percentage (shares_to_burn / total_shares)
    /// 2. For each asset, calculate proportional amount to withdraw
    /// 3. Calculate total withdrawal value in USD
    /// 4. Transfer SOL back to user (30% of vault is in SOL)
    /// 5. For BTC/ETH: Calculate swap to SOL and add to user's withdrawal
    /// 6. Burn user's shares
    /// 7. Update vault state
    pub fn withdraw_multi_asset(
        ctx: Context<WithdrawMultiAsset>,
        name: String,
        shares: u64,
    ) -> Result<()> {
        require!(shares > 0, VaultError::InvalidAmount);

        let vault = &ctx.accounts.vault;
        let total_shares = ctx.accounts.vault_token_mint.supply;

        require!(shares <= total_shares, VaultError::InsufficientShares);
        require!(
            ctx.accounts.user_shares_ata.amount >= shares,
            VaultError::InsufficientShares
        );

        // Validate remaining accounts
        require!(
            ctx.remaining_accounts.len() == vault.assets.len() * 2,
            VaultError::InvalidRemainingAccounts
        );

        msg!("🔓 Starting withdrawal of {} shares...", shares);

        // Fetch Pyth prices
        let clock = &ctx.accounts.clock;
        let current_time = clock.unix_timestamp as u64;

        // Using get_price_unchecked() for devnet since timestamps may be corrupted
        // For mainnet, should use get_price_no_older_than() with proper staleness checking
        let btc_feed: PriceFeed = SolanaPriceAccount::account_info_to_feed(&ctx.accounts.btc_price_feed)
            .map_err(|_| VaultError::InvalidPriceFeed)?;
        let btc_price = btc_feed.get_price_unchecked();
        let btc_normalized = NormalizedPrice::from_pyth(btc_price.price, btc_price.expo)?;

        let eth_feed: PriceFeed = SolanaPriceAccount::account_info_to_feed(&ctx.accounts.eth_price_feed)
            .map_err(|_| VaultError::InvalidPriceFeed)?;
        let eth_price = eth_feed.get_price_unchecked();
        let eth_normalized = NormalizedPrice::from_pyth(eth_price.price, eth_price.expo)?;

        let sol_feed: PriceFeed = SolanaPriceAccount::account_info_to_feed(&ctx.accounts.sol_price_feed)
            .map_err(|_| VaultError::InvalidPriceFeed)?;
        let sol_price = sol_feed.get_price_unchecked();
        let sol_normalized = NormalizedPrice::from_pyth(sol_price.price, sol_price.expo)?;

        msg!(
            "📊 Prices - BTC: ${}, ETH: ${}, SOL: ${}",
            btc_normalized.price_usd,
            eth_normalized.price_usd,
            sol_normalized.price_usd
        );

        // STEP 1: Calculate withdrawal percentage
        // Formula: Withdrawal_Percentage = Shares_to_Burn ÷ Total_Outstanding_Shares
        let withdrawal_percentage = (shares as u128 * 1_000_000) / (total_shares as u128); // Scale by 1M for precision
        msg!(
            "📊 Withdrawal percentage: {}% ({} / {} shares)",
            (withdrawal_percentage * 100) / 1_000_000,
            shares,
            total_shares
        );

        // STEP 2: Calculate proportional asset amounts and total withdrawal value
        let mut total_withdrawal_value_usd = 0i64;
        let mut total_sol_to_return = 0u64;

        for (i, asset) in vault.assets.iter().enumerate() {
            let ata_account_info = &ctx.remaining_accounts[i * 2 + 1];
            
            // Get current balance from ATA
            let ata_data = ata_account_info.try_borrow_data()?;
            let ata = TokenAccount::try_deserialize(&mut &ata_data[..])?;
            let current_balance = ata.amount;
            drop(ata_data); // Release borrow

            // Calculate proportional amount to withdraw
            // Formula: Amount_to_Withdraw = Current_Asset_Amount × Withdrawal_Percentage
            let amount_to_withdraw = ((current_balance as u128 * withdrawal_percentage) / 1_000_000) as u64;

            // Get asset info
            let (decimals, price, asset_name) = match asset.weight {
                40 => (8u8, &btc_normalized, "BTC"),
                30 if i == 1 => (18u8, &eth_normalized, "ETH"),
                30 => (9u8, &sol_normalized, "SOL"),
                _ => continue,
            };

            // Calculate USD value of this withdrawal
            let asset_value_usd = price.tokens_to_usd(amount_to_withdraw, decimals);
            total_withdrawal_value_usd += asset_value_usd;

            msg!(
                "  • {} {}: {} tokens (${} USD)",
                amount_to_withdraw,
                asset_name,
                asset_name,
                asset_value_usd
            );

            // For SOL: Add directly to return amount
            // For BTC/ETH: Calculate equivalent SOL using MockSwap
            if asset_name == "SOL" {
                total_sol_to_return += amount_to_withdraw;
            } else {
                // Use MockSwap to calculate how much SOL we'd get for this asset
                let sol_equivalent = MockSwap::calculate_swap_output(
                    amount_to_withdraw,
                    price.original_price,
                    price.expo,
                    sol_normalized.original_price,
                    sol_normalized.expo,
                    decimals,
                    9, // SOL decimals
                )?;
                total_sol_to_return += sol_equivalent;
                
                msg!(
                    "    → Swapped to {} SOL equivalent",
                    sol_equivalent
                );
            }
        }

        msg!(
            "💰 Total withdrawal value: ${} USD = {} SOL",
            total_withdrawal_value_usd,
            total_sol_to_return
        );

        // STEP 3: Transfer SOL from vault to user
        msg!("💸 Transferring {} SOL to user...", total_sol_to_return);

        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= total_sol_to_return;
        **ctx.accounts.user.to_account_info().try_borrow_mut_lamports()? += total_sol_to_return;

        // STEP 4: Burn shares
        msg!("🔥 Burning {} shares...", shares);
        
        let burn_accounts = anchor_spl::token::Burn {
            mint: ctx.accounts.vault_token_mint.to_account_info(),
            from: ctx.accounts.user_shares_ata.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let burn_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), burn_accounts);
        anchor_spl::token::burn(burn_ctx, shares)?;

        // STEP 5: Calculate new vault state
        let new_total_shares = total_shares - shares;
        
        // Recalculate TVL with remaining assets
        let mut btc_remaining = 0u64;
        let mut eth_remaining = 0u64;
        let mut sol_remaining = 0u64;

        for (i, asset) in vault.assets.iter().enumerate() {
            let ata_account_info = &ctx.remaining_accounts[i * 2 + 1];
            let ata_data = ata_account_info.try_borrow_data()?;
            let ata = TokenAccount::try_deserialize(&mut &ata_data[..])?;
            
            match asset.weight {
                40 => btc_remaining = ata.amount,
                30 if i == 1 => eth_remaining = ata.amount,
                30 => sol_remaining = ata.amount,
                _ => {}
            }
        }

        let new_tvl = Vault::calculate_tvl_from_balances(
            btc_remaining,
            eth_remaining,
            sol_remaining,
            &btc_normalized,
            &eth_normalized,
            &sol_normalized,
        )?;

        let new_share_price = Vault::calculate_share_price(new_tvl, new_total_shares)?;

        msg!("✅ Withdrawal Complete!");
        msg!("   Withdrawn: ${} USD in {} SOL", total_withdrawal_value_usd, total_sol_to_return);
        msg!("   New TVL: ${} USD", new_tvl);
        msg!("   New Total Shares: {}", new_total_shares);
        msg!("   New Share Price: ${} USD", new_share_price);

        // Emit withdrawal event
        emit!(WithdrawEvent {
            vault: vault.key(),
            user: ctx.accounts.user.key(),
            shares_burned: shares,
            amount_withdrawn: total_sol_to_return,
            tvl_usd: new_tvl,
        });

        Ok(())
    }

    /// Set a strategy for the vault (only callable by vault authority)
    /// This allows the vault to delegate asset management to a strategy
    pub fn set_strategy(ctx: Context<SetStrategy>, _name: String, strategy: Pubkey) -> Result<()> {
        let vault = &mut ctx.accounts.vault;

        // Only vault admin can set strategy
        require!(
            ctx.accounts.authority.key() == vault.admin,
            VaultError::Unauthorized
        );

        vault.marinade_strategy = Some(strategy);

        msg!("Strategy set for vault: {}", strategy);

        Ok(())
    }

    /// Remove strategy from vault (only callable by vault authority)
    /// This makes the vault work standalone without delegation
    pub fn remove_strategy(ctx: Context<RemoveStrategy>, _name: String) -> Result<()> {
        let vault = &mut ctx.accounts.vault;

        // Only vault admin can remove strategy
        require!(
            ctx.accounts.authority.key() == vault.admin,
            VaultError::Unauthorized
        );

        vault.marinade_strategy = None;

        msg!("Strategy removed from vault");

        Ok(())
    }
}

// ============================================================================
// Account Validation Structs
// ============================================================================

/// Accounts for creating a new multi-asset vault
///
/// **Architecture Notes:**
/// - Vault PDA: Derived from [b"vault", admin, name] for multi-vault support
/// - Space calculation: Dynamic based on name length and asset count
/// - Share mint: Also a PDA [b"vault_mint", admin, name] for determinism
/// - Remaining accounts: Used for variable asset list (mints + ATAs)
#[derive(Accounts)]
#[instruction(name: String, assets: Vec<AssetConfig>)]
pub struct CreateVault<'info> {
    /// The vault account - stores all composition and state
    /// Uses dynamic space allocation based on name and asset count
    #[account(
        init,
        payer = admin,
        space = Vault::space(name.len(), assets.len()),
        seeds = [b"vault", admin.key().as_ref(), name.as_bytes()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    /// Admin who creates and manages the vault
    /// Pays for account rent and has rebalance permissions
    #[account(mut)]
    pub admin: Signer<'info>,

    /// SPL token mint for vault shares
    /// Vault PDA is mint authority (secure share minting)
    /// 9 decimals for high precision in share calculations
    #[account(
        init,
        payer = admin,
        mint::decimals = 9,
        mint::authority = vault,
        seeds = [b"vault_mint", admin.key().as_ref(), name.as_bytes()],
        bump
    )]
    pub vault_token_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    // remaining_accounts layout (per asset):
    // [0]: mint (UncheckedAccount) - validated in instruction
    // [1]: ata (mut, UncheckedAccount) - vault's ATA, validated and created
    // For N assets: 2*N accounts total
}

#[derive(Accounts)]
#[instruction(name: String)]
pub struct DepositMultiAsset<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.admin.as_ref(), name.as_bytes()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub user: Signer<'info>,

    /// User's ATA to receive vault shares
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = vault_token_mint,
        associated_token::authority = user
    )]
    pub user_shares_ata: Account<'info, TokenAccount>,

    /// Vault's share token mint
    #[account(
        mut,
        seeds = [b"vault_mint", vault.admin.as_ref(), name.as_bytes()],
        bump
    )]
    pub vault_token_mint: Account<'info, Mint>,

    /// CHECK: Pyth BTC/USD price feed account
    #[account(address = BTC_USD_FEED @ VaultError::InvalidPriceFeed)]
    pub btc_price_feed: AccountInfo<'info>,

    /// CHECK: Pyth ETH/USD price feed account
    #[account(address = ETH_USD_FEED @ VaultError::InvalidPriceFeed)]
    pub eth_price_feed: AccountInfo<'info>,

    /// CHECK: Pyth SOL/USD price feed account
    #[account(address = SOL_USD_FEED @ VaultError::InvalidPriceFeed)]
    pub sol_price_feed: AccountInfo<'info>,

    pub clock: Sysvar<'info, Clock>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    
    // remaining_accounts layout:
    // For each asset in vault.assets:
    //   [i*2]: Asset mint account (UncheckedAccount)
    //   [i*2+1]: Vault's ATA for that asset (mut, UncheckedAccount)
}

#[derive(Accounts)]
#[instruction(name: String)]
pub struct WithdrawMultiAsset<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.admin.as_ref(), name.as_bytes()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub user: Signer<'info>,

    /// User's ATA holding vault shares (will be burned)
    #[account(
        mut,
        associated_token::mint = vault_token_mint,
        associated_token::authority = user
    )]
    pub user_shares_ata: Account<'info, TokenAccount>,

    /// Vault's share token mint
    #[account(
        mut,
        seeds = [b"vault_mint", vault.admin.as_ref(), name.as_bytes()],
        bump
    )]
    pub vault_token_mint: Account<'info, Mint>,

    /// CHECK: Pyth BTC/USD price feed account
    #[account(address = BTC_USD_FEED @ VaultError::InvalidPriceFeed)]
    pub btc_price_feed: AccountInfo<'info>,

    /// CHECK: Pyth ETH/USD price feed account
    #[account(address = ETH_USD_FEED @ VaultError::InvalidPriceFeed)]
    pub eth_price_feed: AccountInfo<'info>,

    /// CHECK: Pyth SOL/USD price feed account
    #[account(address = SOL_USD_FEED @ VaultError::InvalidPriceFeed)]
    pub sol_price_feed: AccountInfo<'info>,

    pub clock: Sysvar<'info, Clock>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    
    // remaining_accounts layout:
    // For each asset in vault.assets:
    //   [i*2]: Asset mint account (UncheckedAccount)
    //   [i*2+1]: Vault's ATA for that asset (mut, UncheckedAccount)
}

#[derive(Accounts)]
#[instruction(name: String)]
pub struct SetStrategy<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.admin.as_ref(), name.as_bytes()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(name: String)]
pub struct RemoveStrategy<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.admin.as_ref(), name.as_bytes()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub authority: Signer<'info>,
}

#[error_code]
pub enum VaultError {
    #[msg("Invalid amount: must be greater than 0")]
    InvalidAmount,
    #[msg("Insufficient shares for withdrawal")]
    InsufficientShares,
    #[msg("Insufficient assets in vault")]
    InsufficientAssets,
    #[msg("Math overflow occurred")]
    MathOverflow,
    #[msg("Invalid underlying asset")]
    InvalidUnderlyingAsset,
    #[msg("Unauthorized: only vault authority can perform this action")]
    Unauthorized,
    #[msg("Invalid Price Feed")]
    InvalidPriceFeed,
    #[msg("Stale Price")]
    StalePrice,
    #[msg("Price Confidence Too Low")]
    LowConfidence,

    // Multi-vault composition errors
    #[msg("Sum of asset weights must equal 100")]
    InvalidWeights,
    #[msg("Vault name must be 1-32 characters")]
    InvalidName,
    #[msg("Invalid asset mint provided")]
    InvalidMint,
    #[msg("Invalid ATA address for asset")]
    InvalidATA,
    #[msg("Asset count must be 1-10")]
    InvalidAssetCount,
    #[msg("Incorrect number of remaining accounts")]
    InvalidRemainingAccounts,
    #[msg("Jupiter swap failed")]
    SwapFailed,
    #[msg("Marinade stake/unstake failed")]
    MarinadeError,
    #[msg("Asset not found in vault composition")]
    AssetNotFound,
    #[msg("Insufficient balance for rebalance")]
    InsufficientBalance,
}

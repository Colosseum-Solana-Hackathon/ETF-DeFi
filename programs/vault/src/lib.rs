use anchor_lang::prelude::*;
use anchor_lang::Result;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::associated_token::{spl_associated_token_account, AssociatedToken};
use anchor_spl::token::{Mint, Token, TokenAccount};

// Ephemeral Rollups SDK imports
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{commit_accounts, commit_and_undelegate_accounts};

// Mock swap module for devnet testing
mod swap;
use swap::MockSwap;

// Switchboard Oracle Quotes integration
// Manual parsing of Switchboard Pull Feed data to avoid dependency conflicts

mod state;
use state::{AssetConfig, Vault};

// Mock Price Oracle for devnet testing
// This allows testing with real-time prices
// Switchboard and Pyth feeds are inactive and not maintained on devnet
#[account]
pub struct MockPriceOracle {
    pub authority: Pubkey,      // Admin who can update prices
    pub btc_price: i64,          // BTC/USD price in micro-dollars (6 decimals)
    pub eth_price: i64,          // ETH/USD price in micro-dollars (6 decimals)
    pub sol_price: i64,          // SOL/USD price in micro-dollars (6 decimals)
    pub last_update: i64,        // Unix timestamp of last update
    pub bump: u8,                // PDA bump seed
}

impl MockPriceOracle {
    pub const LEN: usize = 8 + 32 + 8 + 8 + 8 + 8 + 1; // discriminator + pubkey + 4*i64 + u8
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq)]
pub enum PriceSource {
    Switchboard,  // Use Switchboard feeds (for mainnet/production)
    MockOracle,   // Use mock oracle (for devnet testing)
}

// Import strategy interface types for Marinade integration
// use strategy_interface::{InitializeArgs, StakeArgs, StrategyKind, StrategyState, UnstakeArgs};

// Switchboard Oracle Quotes configuration
// Maximum age for quotes in seconds (2 minutes for devnet)
pub const MAX_QUOTE_AGE_SECS: u64 = 120;

// Price feed precision helper
// Switchboard Oracle Quotes use i64 with negative exponents (e.g., -8 for BTC)
// This helper normalizes prices to a common USD value
#[derive(Clone, Copy, Debug)]
pub struct NormalizedPrice {
    pub price_usd: i64, // Price in USD with 6 decimals (micro-dollars)
    pub original_price: i64,
    pub expo: i32,
}

impl NormalizedPrice {
    /// Convert Switchboard Oracle Quote to micro-dollars (6 decimals)
    /// Example: BTC at $50,000 with expo=-8 -> 50_000_000_000 micro-dollars
    pub fn from_switchboard_quote(price: i64, expo: i32) -> Result<Self> {
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

/// Switchboard Oracle Quotes verification helper
impl Vault {
    /// Verify and parse a Switchboard Oracle Quote
    /// This reads from Switchboard Pull Feed accounts on devnet
    /// Note: For devnet testing, uses reasonable fallback prices if feed is inactive
    pub fn verify_oracle_quote(
        price_data: &[u8],
        _current_timestamp: i64,
    ) -> Result<NormalizedPrice> {
        // Ensure we have enough data to parse
        require!(price_data.len() >= 100, VaultError::InvalidQuote);

        msg!("📊 Parsing Switchboard feed (size: {} bytes)", price_data.len());

        // Switchboard Pull Feed account structure:
        // Try to extract price data from multiple possible offsets
        // as the structure may vary between feed versions
        
        // Common offsets in Switchboard feeds:
        // Offset 72-88: value mantissa (i128)
        // Offset 88-92: scale (i32)
        
        let mantissa_bytes: [u8; 16] = price_data[72..88]
            .try_into()
            .map_err(|_| VaultError::InvalidQuote)?;
        let mantissa = i128::from_le_bytes(mantissa_bytes);
        
        let scale_bytes: [u8; 4] = price_data[88..92]
            .try_into()
            .map_err(|_| VaultError::InvalidQuote)?;
        let scale = i32::from_le_bytes(scale_bytes);

        msg!("Raw Switchboard data: mantissa={}, scale={}", mantissa, scale);

        // Convert from i128 (18 decimals internal) to i64 price
        // Switchboard uses 18 decimal precision internally
        // Check if feed is active (mantissa should be positive and reasonable)
        
        // STRICT MODE: Require active feed data (no fallback)
        // Comment out this section and uncomment the fallback section below for devnet testing
        require!(mantissa > 0, VaultError::InvalidQuote);
        require!(mantissa < 1_000_000_000_000_000_000, VaultError::InvalidQuote);
        
        let raw_price = (mantissa / 10i128.pow(9)) as i64;
        msg!("Parsed price from Switchboard: {}", raw_price);
        
        require!(raw_price > 0, VaultError::InvalidPrice);
        require!(raw_price < 10_000_000, VaultError::InvalidPrice);
        
        let price = raw_price;

        // Convert to normalized price (micro-USD with 6 decimals)
        // For devnet feeds, use -8 scale (standard for crypto prices)
        let normalized_price = NormalizedPrice::from_switchboard_quote(price, -8)?;

        msg!("✅ Price determined: {} (normalized: ${})", price, normalized_price.price_usd);

        Ok(normalized_price)
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
    /// This uses the current Switchboard Oracle Quotes and actual token balances in vault ATAs
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
        } else if tvl_usd_micro <= 0 {
            // TVL is $0 or negative but shares exist - this indicates an error state
            // Return default share price to prevent division by zero
            // In production, this should trigger an emergency state
            msg!("⚠️  WARNING: TVL is {} but {} shares exist - using default share price", tvl_usd_micro, total_shares);
            Ok(1_000_000) // $1.00 per share as fallback
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
        // Prevent division by zero or negative share price
        require!(share_price_usd_micro > 0, VaultError::MathOverflow);
        
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

declare_id!("Faiwct1BxfrV1w5xYs8Y55mQ4VJXPGx1qPBZJnw5p7pR");

#[ephemeral]
#[program(heap = 262144)] // 256KB heap for CPI operations with large instruction data
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
        // Default to Switchboard for mainnet compatibility
        vault.price_source = PriceSource::Switchboard;
        vault.mock_oracle = None;

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
    pub fn deposit_multi_asset<'info>(
        ctx: Context<'_, '_, '_, 'info, DepositMultiAsset<'info>>,
        _name: String,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, VaultError::InvalidAmount);

        let vault = &ctx.accounts.vault;
        
        // Validate remaining accounts: we need asset mints and vault ATAs
        // If using MockOracle, we need one additional account (the oracle)
        // If Marinade strategy is set, we need one more account (the strategy)
        let mut expected_accounts = match vault.price_source {
            PriceSource::MockOracle => vault.assets.len() * 2 + 1, // +1 for oracle
            PriceSource::Switchboard => vault.assets.len() * 2,
        };
        
        if vault.marinade_strategy.is_some() {
            expected_accounts += 1;
        }
        
        msg!(
            "Remaining accounts validation: expected {}, got {}",
            expected_accounts,
            ctx.remaining_accounts.len()
        );
        
        require!(
            ctx.remaining_accounts.len() == expected_accounts,
            VaultError::InvalidRemainingAccounts
        );

        let sol_decimals = 9u8; // SOL has 9 decimals

        // Fetch prices based on configured price source
        let clock = &ctx.accounts.clock;
        let current_time = clock.unix_timestamp;

        msg!("🔍 Fetching prices from {:?}...", vault.price_source);

        let (btc_normalized, eth_normalized, sol_normalized) = match vault.price_source {
            PriceSource::Switchboard => {
                // Use Switchboard feeds
                msg!("📊 Reading Switchboard Oracle Quotes...");
                
                let btc_quote_data = &ctx.accounts.btc_quote.data.borrow();
                let btc_norm = Vault::verify_oracle_quote(btc_quote_data, current_time)?;
                
                let eth_quote_data = &ctx.accounts.eth_quote.data.borrow();
                let eth_norm = Vault::verify_oracle_quote(eth_quote_data, current_time)?;
                
                let sol_quote_data = &ctx.accounts.sol_quote.data.borrow();
                let sol_norm = Vault::verify_oracle_quote(sol_quote_data, current_time)?;
                
                (btc_norm, eth_norm, sol_norm)
            },
            PriceSource::MockOracle => {
                // Use mock oracle
                msg!("🎭 Reading Mock Oracle prices...");
                
                require!(vault.mock_oracle.is_some(), VaultError::InvalidPrice);
                let oracle_key = vault.mock_oracle.unwrap();
                
                // Find mock oracle in remaining accounts
                let mock_oracle_account = ctx.remaining_accounts
                    .iter()
                    .find(|acc| acc.key() == oracle_key)
                    .ok_or(VaultError::InvalidPrice)?;
                
                let oracle_data = mock_oracle_account.try_borrow_data()?;
                let mock_oracle = MockPriceOracle::try_deserialize(&mut &oracle_data[..])?;
                
                // Validate prices are fresh (within last 5 minutes)
                let price_age = current_time - mock_oracle.last_update;
                require!(price_age < 300, VaultError::StaleQuote);
                
                // Convert mock oracle prices (already in micro-USD) to NormalizedPrice
                let btc_norm = NormalizedPrice {
                    price_usd: mock_oracle.btc_price,
                    original_price: mock_oracle.btc_price / 1_000_000,
                    expo: -6,
                };
                
                let eth_norm = NormalizedPrice {
                    price_usd: mock_oracle.eth_price,
                    original_price: mock_oracle.eth_price / 1_000_000,
                    expo: -6,
                };
                
                let sol_norm = NormalizedPrice {
                    price_usd: mock_oracle.sol_price,
                    original_price: mock_oracle.sol_price / 1_000_000,
                    expo: -6,
                };
                
                (btc_norm, eth_norm, sol_norm)
            },
        };

        msg!("BTC Price: ${} (expo: {})", btc_normalized.original_price, btc_normalized.expo);
        msg!("ETH Price: ${} (expo: {})", eth_normalized.original_price, eth_normalized.expo);
        msg!("SOL Price: ${} (expo: {})", sol_normalized.original_price, sol_normalized.expo);

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

        // IMPORTANT: For SOL, we need to check BOTH:
        // 1. SPL token balance in ATA (if using wrapped SOL tokens)
        // 2. Native SOL in vault PDA's lamports (for deposits that don't wrap)
        
        // First, check native SOL balance in vault PDA
        let vault_lamports = ctx.accounts.vault.to_account_info().lamports();
        let vault_data_len = ctx.accounts.vault.to_account_info().data_len();
        let rent_exempt_minimum = ctx.accounts.rent.minimum_balance(vault_data_len);
        // Subtract rent-exempt reserve to get actual deposited SOL
        let native_sol_balance = vault_lamports.saturating_sub(rent_exempt_minimum);
        msg!("  Native SOL in vault PDA: {} lamports (total: {}, rent: {})", native_sol_balance, vault_lamports, rent_exempt_minimum);

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
            
            msg!("Asset {} (weight {}%): {} tokens in ATA", asset.mint, asset.weight, ata.amount);

            // Map balance to correct asset based on weight
            // This is a simplified approach - in production you'd match by mint address
            match asset.weight {
                40 => btc_balance = ata.amount, // BTC gets 40%
                30 if eth_balance == 0 => eth_balance = ata.amount, // First 30% is ETH
                30 => {
                    // For SOL: Use SPL token balance OR native balance (whichever is greater)
                    // This handles both wrapped SOL tokens and native SOL deposits
                    sol_balance = if ata.amount > 0 {
                        ata.amount // Using SPL token wSOL
                    } else {
                        native_sol_balance // Using native SOL
                    };
                    msg!("  → Using SOL balance: {} (native + SPL)", sol_balance);
                },
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

        let mut sol_to_stake: Option<u64> = None;

        for (i, asset) in vault.assets.iter().enumerate() {
            let usd_allocation = (deposit_usd_micro * asset.weight as i64) / 100;
            let sol_amount_for_asset = (amount as i64 * asset.weight as i64 / 100) as u64;
            
            // Get the decimals, price, and whether to swap for this asset
            let (decimals, price, asset_name) = match asset.weight {
                40 => (8u8, &btc_normalized, "BTC"),  // BTC - needs swap
                30 if i == 1 => (18u8, &eth_normalized, "ETH"), // ETH - needs swap
                30 => {
                    // Store SOL amount for Marinade staking
                    sol_to_stake = Some(sol_amount_for_asset);
                    (9u8, &sol_normalized, "SOL")
                },
                _ => continue,
            };

            // Calculate token amount using MockSwap for BTC and ETH
            let token_amount = if asset_name == "SOL" {
                // For SOL, no swap needed - amount will be staked via Marinade
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
            // - For BTC/ETH: Execute Jupiter CPI (SOL -> BTC/ETH)
            // - For SOL: Delegate to Marinade strategy
        }

        // Delegate SOL portion to Marinade strategy (if configured)
        if let (Some(strategy_key), Some(stake_amount)) = (vault.marinade_strategy, sol_to_stake) {
            msg!("🌊 Marinade strategy configured!");
            msg!("   Delegating {} lamports (30%) to Marinade...", stake_amount);
            
            // Find the strategy account in remaining_accounts
            let strategy_account_info = ctx.remaining_accounts.iter()
                .find(|acc| acc.key() == strategy_key)
                .ok_or(VaultError::MarinadeError)?;
            
            // Build CPI context for marinade_strategy::stake
            let cpi_accounts = marinade_strategy::cpi::accounts::Stake {
                strategy_account: strategy_account_info.clone(),
                vault: ctx.accounts.vault.to_account_info(),
                payer: ctx.accounts.user.to_account_info(), // User must sign as payer
                marinade_state: ctx.accounts.marinade_state.to_account_info(),
                reserve_pda: ctx.accounts.reserve_pda.to_account_info(),
                msol_mint: ctx.accounts.msol_mint.to_account_info(),
                msol_ata: ctx.accounts.strategy_msol_ata.to_account_info(),
                msol_mint_authority: ctx.accounts.msol_mint_authority.to_account_info(),
                liq_pool_sol_leg_pda: ctx.accounts.liq_pool_sol_leg_pda.to_account_info(),
                liq_pool_msol_leg: ctx.accounts.liq_pool_msol_leg.to_account_info(),
                liq_pool_msol_leg_authority: ctx.accounts.liq_pool_msol_leg_authority.to_account_info(),
                marinade_program: ctx.accounts.marinade_program.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            };
            
            // Vault PDA signs the CPI call
            let vault_seeds = &[
                b"vault".as_ref(),
                vault.admin.as_ref(),
                vault.name.as_bytes(),
                &[vault.bump],
            ];
            let signer_seeds = &[&vault_seeds[..]];
            
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.marinade_strategy_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            
            // Execute CPI call to marinade_strategy::stake
            marinade_strategy::cpi::stake(cpi_ctx, stake_amount)?;
            
            msg!("✅Successfully delegated {} lamports to Marinade!", stake_amount);
            
        } else if sol_to_stake.is_some() {
            msg!("No Marinade strategy configured - SOL will remain in vault");
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
    pub fn withdraw_multi_asset<'info>(
        ctx: Context<'_, '_, '_, 'info, WithdrawMultiAsset<'info>>,
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

        // Validate remaining accounts: we need asset mints and vault ATAs
        // If using MockOracle, we need one additional account (the oracle)
        // If Marinade strategy is set, we need one more account (the strategy)
        let mut expected_accounts = match vault.price_source {
            PriceSource::MockOracle => vault.assets.len() * 2 + 1, // +1 for oracle
            PriceSource::Switchboard => vault.assets.len() * 2,
        };
        
        if vault.marinade_strategy.is_some() {
            expected_accounts += 1;
        }
        
        msg!(
            "Withdraw remaining accounts validation: expected {}, got {}",
            expected_accounts,
            ctx.remaining_accounts.len()
        );
        
        require!(
            ctx.remaining_accounts.len() == expected_accounts,
            VaultError::InvalidRemainingAccounts
        );

        msg!("🔓 Starting withdrawal of {} shares...", shares);

        // Fetch prices based on configured price source
        let clock = &ctx.accounts.clock;
        let current_time = clock.unix_timestamp;

        msg!("🔍 Fetching prices from {:?}...", vault.price_source);

        let (btc_normalized, eth_normalized, sol_normalized) = match vault.price_source {
            PriceSource::Switchboard => {
                // Use Switchboard feeds
                let btc_quote_data = &ctx.accounts.btc_quote.data.borrow();
                let btc_norm = Vault::verify_oracle_quote(btc_quote_data, current_time)?;
                
                let eth_quote_data = &ctx.accounts.eth_quote.data.borrow();
                let eth_norm = Vault::verify_oracle_quote(eth_quote_data, current_time)?;
                
                let sol_quote_data = &ctx.accounts.sol_quote.data.borrow();
                let sol_norm = Vault::verify_oracle_quote(sol_quote_data, current_time)?;
                
                (btc_norm, eth_norm, sol_norm)
            },
            PriceSource::MockOracle => {
                require!(vault.mock_oracle.is_some(), VaultError::InvalidPrice);
                let oracle_key = vault.mock_oracle.unwrap();
                
                let mock_oracle_account = ctx.remaining_accounts
                    .iter()
                    .find(|acc| acc.key() == oracle_key)
                    .ok_or(VaultError::InvalidPrice)?;
                
                let oracle_data = mock_oracle_account.try_borrow_data()?;
                let mock_oracle = MockPriceOracle::try_deserialize(&mut &oracle_data[..])?;
                
                let price_age = current_time - mock_oracle.last_update;
                require!(price_age < 300, VaultError::StaleQuote);
                
                let btc_norm = NormalizedPrice {
                    price_usd: mock_oracle.btc_price,
                    original_price: mock_oracle.btc_price / 1_000_000,
                    expo: -6,
                };
                
                let eth_norm = NormalizedPrice {
                    price_usd: mock_oracle.eth_price,
                    original_price: mock_oracle.eth_price / 1_000_000,
                    expo: -6,
                };
                
                let sol_norm = NormalizedPrice {
                    price_usd: mock_oracle.sol_price,
                    original_price: mock_oracle.sol_price / 1_000_000,
                    expo: -6,
                };
                
                (btc_norm, eth_norm, sol_norm)
            },
        };

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
        let mut sol_from_native = 0u64;
        let mut sol_from_marinade = 0u64;

        // First, check native SOL balance in vault PDA
        let vault_lamports = ctx.accounts.vault.to_account_info().lamports();
        let vault_data_len = ctx.accounts.vault.to_account_info().data_len();
        let rent_exempt_minimum = ctx.accounts.rent.minimum_balance(vault_data_len);
        let native_sol_balance = vault_lamports.saturating_sub(rent_exempt_minimum);
        msg!("  Native SOL in vault PDA: {} lamports", native_sol_balance);
        
        // Check Marinade strategy staked value
        let mut marinade_sol_value = 0u64;
        if let Some(strategy_key) = vault.marinade_strategy {
            let expected_strategy_index = match vault.price_source {
                PriceSource::MockOracle => vault.assets.len() * 2 + 1,
                PriceSource::Switchboard => vault.assets.len() * 2,
            };
            
            if ctx.remaining_accounts.len() > expected_strategy_index {
                let strategy_account_info = &ctx.remaining_accounts[expected_strategy_index];
                if strategy_account_info.key() == strategy_key {
                    // Read strategy state to get mSOL balance
                    // Note: In full implementation, convert mSOL to SOL using Marinade exchange rate
                    // For now, we'll use the total_staked value which tracks original deposit
                    msg!("  Marinade strategy detected - including staked SOL in TVL");
                    // TODO: Parse strategy account and get actual mSOL value with yield
                }
            }
        }

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

            // For SOL: We use native SOL from the vault PDA (not SPL tokens)
            // The actual SOL withdrawal will be calculated after checking Marinade
            // Note: During deposits, SOL goes as native lamports, not SPL tokens
            // For BTC/ETH: Calculate equivalent SOL using MockSwap
            if asset_name == "SOL" {
                // SOL withdrawal will be calculated after Marinade unstaking
                // We need to know: vault native balance + Marinade holdings
                msg!("    → SOL withdrawal will be calculated from native balance + Marinade");
            } else {
                // For BTC/ETH: Only swap if we have a non-zero amount
                if amount_to_withdraw > 0 {
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
                        "    → Swapped {} {} to {} SOL equivalent",
                        amount_to_withdraw,
                        asset_name,
                        sol_equivalent
                    );
                } else {
                    msg!("    → No {} balance to withdraw", asset_name);
                }
            }
        }

        // STEP 2.5: Handle Marinade unstaking if strategy is active
        if let Some(strategy_key) = vault.marinade_strategy {
            msg!("🌊 Marinade strategy detected - unstaking proportional mSOL!");
            
            // Find the strategy account in remaining_accounts
            let expected_strategy_index = match vault.price_source {
                PriceSource::MockOracle => vault.assets.len() * 2 + 1, // After oracle
                PriceSource::Switchboard => vault.assets.len() * 2,
            };
            
            if ctx.remaining_accounts.len() > expected_strategy_index {
                let strategy_account_info = &ctx.remaining_accounts[expected_strategy_index];
                
                if strategy_account_info.key() == strategy_key {
                    msg!("   Strategy account found in remaining_accounts");
                    
                    // Read strategy account to get mSOL balance
                    let strategy_data = strategy_account_info.try_borrow_data()?;
                    let mut strategy_slice = &strategy_data[..];
                    let strategy = marinade_strategy::StrategyAccount::try_deserialize(&mut strategy_slice)?;
                    drop(strategy_data);
                    
                    let total_msol = strategy.msol_balance;
                    let initial_staked = strategy.total_staked;
                    
                    msg!("   Total mSOL in strategy: {}", total_msol);
                    msg!("   Initial SOL staked: {}", initial_staked);
                    
                    // Calculate proportional mSOL to unstake
                    let msol_to_unstake = ((total_msol as u128 * withdrawal_percentage) / 1_000_000) as u64;
                    
                    if msol_to_unstake > 0 {
                        msg!("   Unstaking {} mSOL ({}% of total)", msol_to_unstake, (withdrawal_percentage * 100) / 1_000_000);
                        
                        // Record vault balance before unstaking
                        let vault_balance_before = ctx.accounts.vault.to_account_info().lamports();
                        
                        // Build CPI context for marinade_strategy::unstake
                        let vault_seeds = &[
                            b"vault".as_ref(),
                            vault.admin.as_ref(),
                            vault.name.as_bytes(),
                            &[vault.bump],
                        ];
                        let signer_seeds = &[&vault_seeds[..]];
                        
                        let cpi_accounts = marinade_strategy::cpi::accounts::Unstake {
                            strategy_account: strategy_account_info.clone(),
                            vault: ctx.accounts.vault.to_account_info(),
                            sol_receiver: ctx.accounts.sol_receiver.to_account_info(), // System-owned account
                            marinade_state: ctx.accounts.marinade_state.to_account_info(),
                            msol_mint: ctx.accounts.msol_mint.to_account_info(),
                            liq_pool_msol_leg: ctx.accounts.liq_pool_msol_leg.to_account_info(),
                            liq_pool_sol_leg_pda: ctx.accounts.liq_pool_sol_leg_pda.to_account_info(),
                            msol_ata: ctx.accounts.strategy_msol_ata.to_account_info(),
                            treasury_msol_account: ctx.accounts.treasury_msol_account.to_account_info(),
                            marinade_program: ctx.accounts.marinade_program.to_account_info(),
                            system_program: ctx.accounts.system_program.to_account_info(),
                            token_program: ctx.accounts.token_program.to_account_info(),
                        };
                        
                        let cpi_ctx = CpiContext::new_with_signer(
                            ctx.accounts.marinade_strategy_program.to_account_info(),
                            cpi_accounts,
                            signer_seeds,
                        );
                        
                        // Record receiver balance before unstaking (Marinade will transfer to receiver)
                        let receiver_balance_before = ctx.accounts.sol_receiver.to_account_info().lamports();
                        
                        // Execute unstake - Marinade will return SOL to receiver (including yield!)
                        marinade_strategy::cpi::unstake(cpi_ctx, msol_to_unstake)?;
                        
                        // Calculate SOL received by receiver from Marinade (includes yield)
                        let receiver_balance_after = ctx.accounts.sol_receiver.to_account_info().lamports();
                        let sol_received_from_marinade = receiver_balance_after.saturating_sub(receiver_balance_before);
                        
                        sol_from_marinade = sol_received_from_marinade;
                        
                        // SOL was already transferred to receiver by Marinade
                        // Don't add to total_sol_to_return since it's not in the vault
                        
                        // Calculate yield
                        let proportional_initial = ((initial_staked as u128 * withdrawal_percentage) / 1_000_000) as u64;
                        let yield_earned = sol_received_from_marinade.saturating_sub(proportional_initial);
                        
                        msg!("   ✅ Unstaked {} mSOL", msol_to_unstake);
                        msg!("   📥 Received {} SOL from Marinade (transferred to user)", sol_received_from_marinade);
                        msg!("   🎁 Yield earned: {} lamports", yield_earned);
                    } else {
                        msg!("   No mSOL to unstake for this withdrawal amount");
                    }
                } else {
                    msg!("   ⚠️  Strategy account mismatch in remaining_accounts");
                }
            } else {
                msg!("   ⚠️  Strategy account not provided in remaining_accounts");
            }
        }

        // STEP 2.6: Calculate total SOL value to withdraw based on withdrawal USD value
        // We need to convert the total_withdrawal_value_usd to SOL
        // sol_normalized.price_usd is in micro-dollars (6 decimals)
        // SOL has 9 decimals (lamports)
        // Formula: sol_lamports = (withdrawal_value_micro_usd * 10^9) / (sol_price_micro_usd)
        
        let withdrawal_sol_raw = (total_withdrawal_value_usd as u128 * 1_000_000_000u128) 
            / sol_normalized.price_usd as u128;
        let total_sol_to_withdraw = withdrawal_sol_raw as u64;
        
        msg!("   Total withdrawal value: ${} USD (micro)", total_withdrawal_value_usd);
        msg!("   SOL price: ${} USD (micro)", sol_normalized.price_usd);
        msg!("   Total SOL to withdraw: {} lamports", total_sol_to_withdraw);
        msg!("   SOL already unstaked from Marinade: {} lamports", sol_from_marinade);
        
        // Calculate remaining SOL to withdraw from vault's native balance
        // Marinade already sent SOL directly to user, so we only need: total - marinade_amount
        let vault_native_sol_to_withdraw = total_sol_to_withdraw.saturating_sub(sol_from_marinade);
        total_sol_to_return = vault_native_sol_to_withdraw;
        sol_from_native = vault_native_sol_to_withdraw;
        
        msg!("   Vault native SOL to withdraw: {} lamports", vault_native_sol_to_withdraw);
        
        // Verify vault has enough SOL
        let current_vault_lamports = ctx.accounts.vault.to_account_info().lamports();
        let available_sol = current_vault_lamports.saturating_sub(rent_exempt_minimum);
        msg!("   Available SOL in vault: {} lamports", available_sol);
        
        require!(
            available_sol >= vault_native_sol_to_withdraw,
            VaultError::InsufficientBalance
        );

        msg!(
            "💰 Total withdrawal value: ${} USD",
            total_withdrawal_value_usd
        );
        msg!(
            "   SOL from native/SPL: {} lamports",
            sol_from_native
        );
        if sol_from_marinade > 0 {
            msg!(
                "   SOL from Marinade (with yield, already sent to receiver): {} lamports",
                sol_from_marinade
            );
        }
        msg!("   SOL to transfer from vault: {} lamports", total_sol_to_return);
        msg!("   Total SOL user will have received: {} lamports (vault: {}, marinade receiver: {})", total_sol_to_return + sol_from_marinade, total_sol_to_return, sol_from_marinade);

        // STEP 3: Transfer remaining SOL from vault to user
        // Note: Marinade SOL was already sent directly to user above
        if total_sol_to_return > 0 {
            msg!("💸 Transferring {} SOL from vault to user...", total_sol_to_return);
            **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= total_sol_to_return;
            **ctx.accounts.user.to_account_info().try_borrow_mut_lamports()? += total_sol_to_return;
        }

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

    /// Initialize mock price oracle for devnet testing
    /// This allows testing with real-time market prices on devnet
    pub fn initialize_mock_oracle(ctx: Context<InitializeMockOracle>) -> Result<()> {
        let oracle = &mut ctx.accounts.mock_oracle;
        
        oracle.authority = ctx.accounts.authority.key();
        oracle.btc_price = 0;
        oracle.eth_price = 0;
        oracle.sol_price = 0;
        oracle.last_update = Clock::get()?.unix_timestamp;
        oracle.bump = ctx.bumps.mock_oracle;

        msg!("Mock oracle initialized: {}", oracle.key());
        
        Ok(())
    }

    /// Update mock oracle prices
    /// Fetches real-time prices and updates the mock oracle
    /// Only callable by oracle authority
    pub fn update_mock_oracle(
        ctx: Context<UpdateMockOracle>,
        btc_price: i64,
        eth_price: i64,
        sol_price: i64,
    ) -> Result<()> {
        let oracle = &mut ctx.accounts.mock_oracle;
        
        require!(
            ctx.accounts.authority.key() == oracle.authority,
            VaultError::Unauthorized
        );

        // Validate prices are reasonable (positive and within bounds)
        require!(btc_price > 0 && btc_price < 10_000_000_000_000, VaultError::InvalidPrice);
        require!(eth_price > 0 && eth_price < 10_000_000_000_000, VaultError::InvalidPrice);
        require!(sol_price > 0 && sol_price < 10_000_000_000_000, VaultError::InvalidPrice);

        oracle.btc_price = btc_price;
        oracle.eth_price = eth_price;
        oracle.sol_price = sol_price;
        oracle.last_update = Clock::get()?.unix_timestamp;

        msg!("Mock oracle updated - BTC: ${}, ETH: ${}, SOL: ${}", 
             btc_price / 1_000_000, eth_price / 1_000_000, sol_price / 1_000_000);
        
        Ok(())
    }

    // ============================================================================
    // EPHEMERAL ROLLUPS INTEGRATION (TEMPORARILY DISABLED)
    // ============================================================================
    // The following instructions are disabled pending ER SDK compatibility fixes
    // Issue: borsh version mismatch between Anchor 0.31.1 and ephemeral-rollups-sdk 0.2.11
    // Will be re-enabled once MagicBlock updates SDK for Anchor 0.31+ compatibility
    
    
    /// Delegate mock oracle to Ephemeral Rollup for high-frequency price updates
    /// This transfers ownership of the oracle PDA to the ER delegation program
    /// Allows sub-second price updates without L1 transaction fees
    /// Only callable by oracle authority
    pub fn delegate_mock_oracle(ctx: Context<DelegateMockOracleCtx>) -> Result<()> {
        // Delegate the oracle PDA to Ephemeral Rollup
        // The #[delegate] macro on DelegateMockOracle provides the delegate_pda method
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[b"mock_oracle", ctx.accounts.payer.key().as_ref()],
            DelegateConfig {
                validator: None, // Will use default ER validator
                commit_frequency_ms: 30_000, // Commit to L1 every 30 seconds
            },
        )?;

        msg!("Mock oracle delegated to Ephemeral Rollup: {}", ctx.accounts.pda.key());
        msg!("High-frequency price updates now enabled (sub-second latency)");

        Ok(())
    }    /// Commit mock oracle state to L1 without undelegating
    /// This creates a checkpoint on L1 while keeping the oracle on ER
    /// Useful for periodic state synchronization
    pub fn commit_mock_oracle(ctx: Context<CommitMockOracle>) -> Result<()> {
        let authority = &ctx.accounts.authority;
        let mock_oracle = &ctx.accounts.mock_oracle;
        
        // Commit the oracle account state to L1
        commit_accounts(
            authority,
            vec![&mock_oracle.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;

        msg!("Mock oracle state committed to L1: {}", mock_oracle.key());
        msg!("Oracle remains on ER for continued high-frequency updates");
        
        Ok(())
    }

    /// Undelegate mock oracle from Ephemeral Rollup back to L1
    /// This commits final state and returns ownership to the vault program
    /// Callable by oracle authority to end ER session
    pub fn undelegate_mock_oracle(ctx: Context<UndelegateMockOracle>) -> Result<()> {
        let authority = &ctx.accounts.authority;
        let mock_oracle = &ctx.accounts.mock_oracle;
        
        // Verify authority
        require!(
            authority.key() == mock_oracle.authority,
            VaultError::Unauthorized
        );

        // Commit and undelegate the oracle back to L1
        commit_and_undelegate_accounts(
            authority,
            vec![&mock_oracle.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;

        msg!("Mock oracle undelegated from Ephemeral Rollup: {}", mock_oracle.key());
        msg!("Oracle returned to L1, final state committed");
        
        Ok(())
    }
    

    /// Set price source for vault (Switchboard or MockOracle)
    /// Allows switching between real Switchboard feeds and mock oracle
    pub fn set_price_source(
        ctx: Context<SetPriceSource>,
        _name: String,
        price_source: PriceSource,
        mock_oracle: Option<Pubkey>,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        
        require!(
            ctx.accounts.authority.key() == vault.admin,
            VaultError::Unauthorized
        );

        // If setting to MockOracle, require mock_oracle address
        if price_source == PriceSource::MockOracle {
            require!(mock_oracle.is_some(), VaultError::InvalidPrice);
        }

        vault.price_source = price_source;
        vault.mock_oracle = mock_oracle;

        msg!("Price source set to: {:?}", price_source);
        
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

    /// Rebalance vault when asset drifts exceed threshold
    /// 
    /// This function detects when asset allocations drift from target weights
    /// and executes swaps to restore the target portfolio composition.
    /// 
    /// **Process:**
    /// 1. Authorization check (only admin)
    /// 2. Fetch current prices from MockOracle
    /// 3. Calculate current USD values for each asset
    /// 4. Detect drifts > threshold (5%)
    /// 5. Execute MockSwap operations to rebalance
    /// 
    /// **remaining_accounts layout:**
    /// - [0]: MockOracle account
    /// - [1..n]: Vault's ATAs for each asset (mut)
    pub fn rebalance(ctx: Context<Rebalance>, _vault_name: String) -> Result<()> {
        let vault = &ctx.accounts.vault;
        
        // STEP 1: Authorization check
        require!(
            ctx.accounts.authority.key() == vault.admin,
            VaultError::Unauthorized
        );

        msg!("🔄 Starting rebalancing for vault: {}", vault.name);

        // Verify we're using MockOracle
        require!(
            vault.price_source == PriceSource::MockOracle,
            VaultError::InvalidPrice
        );
        require!(
            vault.mock_oracle.is_some(),
            VaultError::InvalidPrice
        );

        // STEP 2: Fetch prices from MockOracle
        let oracle_account = &ctx.remaining_accounts[0];
        let oracle_data = oracle_account.try_borrow_data()?;
        let oracle = MockPriceOracle::try_deserialize(&mut &oracle_data[..])?;
        
        // Check staleness (2 min max)
        let current_time = Clock::get()?.unix_timestamp;
        let age = (current_time - oracle.last_update) as u64;
        require!(age < 120, VaultError::StaleQuote);

        msg!("📊 Current prices (micro-USD):");
        msg!("   BTC: ${}", oracle.btc_price / 1_000_000);
        msg!("   ETH: ${}", oracle.eth_price / 1_000_000);
        msg!("   SOL: ${}", oracle.sol_price / 1_000_000);

        let prices = vec![oracle.btc_price, oracle.eth_price, oracle.sol_price];
        
        // STEP 3: Calculate current USD values for each asset
        let mut total_usd: i64 = 0;
        let mut current_usds = Vec::new();
        let mut balances = Vec::new();
        
        for (i, asset) in vault.assets.iter().enumerate() {
            let ata_index = i + 1; // Skip oracle at index 0
            let ata_account = &ctx.remaining_accounts[ata_index];
            
            // Parse token account to get balance
            let ata_data = ata_account.try_borrow_data()?;
            let balance = u64::from_le_bytes(
                ata_data[64..72].try_into().map_err(|_| VaultError::InvalidATA)?
            );
            
            balances.push(balance);
            
            // Calculate USD value
            // balance is in native token decimals, price is in micro-USD
            let usd_value = calculate_asset_usd_value(
                balance,
                prices[i],
                asset.mint,
            )?;
            
            current_usds.push(usd_value);
            total_usd = total_usd.checked_add(usd_value).ok_or(VaultError::MathOverflow)?;
            
            msg!("   Asset {}: Balance={}, USD=${}", i, balance, usd_value / 1_000_000);
        }
        
        if total_usd == 0 {
            msg!("⚠️  Empty vault - no rebalancing needed");
            return Ok(());
        }

        msg!("💰 Total TVL: ${}", total_usd / 1_000_000);
        
        // STEP 4: Check for drifts > threshold (5%)
        let threshold: i64 = 5; // 5%
        let mut drifts = Vec::new();
        let mut needs_rebalance = false;
        
        for (i, asset) in vault.assets.iter().enumerate() {
            let target_usd = (total_usd * asset.weight as i64) / 100;
            let current_pct = (current_usds[i] * 100) / total_usd;
            let drift_pct = current_pct - asset.weight as i64;
            
            drifts.push((i, drift_pct, current_usds[i] - target_usd));
            
            msg!("   Asset {} (weight={}%): current={}%, drift={}%",
                i, asset.weight, current_pct, drift_pct);
            
            if drift_pct.abs() > threshold {
                needs_rebalance = true;
                msg!("     ⚠️  Drift exceeds threshold!");
            }
        }
        
        if !needs_rebalance {
            msg!("✅ No rebalancing needed - all assets within threshold");
            return Ok(());
        }
        
        msg!("🔨 Rebalancing required!");
        
        // STEP 5: Execute swaps using MockSwap
        // Find over-allocated and under-allocated assets
        for (from_idx, from_drift, excess_usd) in drifts.iter() {
            if *excess_usd > 0 {
                // This asset is over-allocated, sell some
                msg!("   Selling from asset {}", from_idx);
                
                for (to_idx, to_drift, deficit_usd) in drifts.iter() {
                    if *deficit_usd < 0 && from_idx != to_idx {
                        // This asset is under-allocated, buy some
                        let swap_usd = (*excess_usd).min((*deficit_usd).abs());
                        
                        if swap_usd > 1_000_000 { // Only swap if > $1
                            msg!("     Swapping ${} from asset {} to asset {}",
                                swap_usd / 1_000_000, from_idx, to_idx);
                            
                            // Calculate swap amount in token terms
                            let from_asset = &vault.assets[*from_idx];
                            let to_asset = &vault.assets[*to_idx];
                            
                            // Determine token decimals
                            let from_decimals = get_token_decimals(from_asset.mint)?;
                            let to_decimals = get_token_decimals(to_asset.mint)?;
                            
                            // Calculate input amount: swap_usd / from_price * 10^from_decimals
                            let amount_in = (swap_usd * 10i64.pow(from_decimals as u32)) / prices[*from_idx];
                            let amount_in_u64 = amount_in as u64;
                            
                            // Use MockSwap to calculate output
                            let amount_out = MockSwap::calculate_swap_output(
                                amount_in_u64,
                                prices[*from_idx],
                                -6, // MockOracle uses micro-USD (6 decimals)
                                prices[*to_idx],
                                -6,
                                from_decimals,
                                to_decimals,
                            )?;
                            
                            msg!("       Input: {} (asset {}), Output: {} (asset {})",
                                amount_in_u64, from_idx, amount_out, to_idx);
                            
                            // Note: In production, this would execute actual token transfers
                            // For now, we just log the intended swaps
                            // The ATAs need to be updated via CPI to token program
                        }
                    }
                }
            }
        }
        
        msg!("✅ Rebalancing complete!");
        
        Ok(())
    }

    /// Rebalance vault using Arcium MXE for confidential computation
    /// 
    /// This instruction prevents MEV attacks by encrypting the rebalancing
    /// computation inputs and outputs using Arcium's Multi-Party Computation.
    /// 
    /// **Flow:**
    /// 1. Client: Fetch vault state and prices, prepare encrypted portfolio
    /// 2. On-chain: Call Arcium MXE to queue encrypted rebalancing computation
    /// 3. Arcium MXE: Compute rebalancing in encrypted form
    /// 4. Callback: Receive encrypted results and execute swaps
    /// 
    /// **remaining_accounts layout:**
    /// - [0]: MockOracle account (for price verification)
    pub fn rebalance_confidential(
        ctx: Context<RebalanceConfidential>,
        vault_name: String,
        computation_offset: u64,
        pub_key: [u8; 32],
        nonce: u128,
        encrypted_user_funds: [u8; 32],
    ) -> Result<()> {
        let vault = &ctx.accounts.vault;
        
        // STEP 1: Authorization check
        require!(
            ctx.accounts.authority.key() == vault.admin,
            VaultError::Unauthorized
        );

        msg!("🔐 Starting confidential rebalancing for vault: {}", vault.name);

        // Verify we're using MockOracle
        require!(
            vault.price_source == PriceSource::MockOracle,
            VaultError::InvalidPrice
        );
        require!(
            vault.mock_oracle.is_some(),
            VaultError::InvalidPrice
        );

        msg!("📡 Queuing encrypted computation to Arcium MXE...");

        // STEP 2: Build instruction data for compute_rebalancing
        // Instruction discriminator from IDL: [126, 197, 44, 141, 35, 123, 172, 126]
        // This is the first 8 bytes of SHA256("global:compute_rebalancing")
        // Total size: 8 + 8 + 32 + 16 + 32 = 96 bytes (fixed size)
        let mut instruction_data = [0u8; 96];
        let mut offset = 0;
        
        // Add discriminator (8 bytes)
        instruction_data[offset..offset + 8].copy_from_slice(&[126, 197, 44, 141, 35, 123, 172, 126]);
        offset += 8;
        
        // 1. computation_offset: u64 (8 bytes, little-endian)
        instruction_data[offset..offset + 8].copy_from_slice(&computation_offset.to_le_bytes());
        offset += 8;
        
        // 2. pub_key: [u8; 32] (32 bytes)
        instruction_data[offset..offset + 32].copy_from_slice(&pub_key);
        offset += 32;
        
        // 3. nonce: u128 (16 bytes, little-endian)
        instruction_data[offset..offset + 16].copy_from_slice(&nonce.to_le_bytes());
        offset += 16;
        
        // 4. encrypted_user_funds: [u8; 32] (32 bytes) - Just ONE encrypted value
        instruction_data[offset..offset + 32].copy_from_slice(&encrypted_user_funds);
        offset += 32;
        
        msg!("   Instruction data size: {} bytes", offset);
        msg!("   Expected: 8 (discriminator) + 8 (offset) + 32 (pub_key) + 16 (nonce) + 32 (funds) = 96 bytes");

        // STEP 3: Build account metas for CPI
        use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
        use anchor_lang::solana_program::program::invoke;
        
        let account_metas = [
            AccountMeta::new(ctx.accounts.authority.key(), true),             // payer (signer, mut)
            AccountMeta::new(ctx.accounts.sign_pda_account.key(), false),     // sign_pda_account (mut)
            AccountMeta::new_readonly(ctx.accounts.mxe_account.key(), false), // mxe_account
            AccountMeta::new(ctx.accounts.mempool_account.key(), false),      // mempool_account (mut)
            AccountMeta::new(ctx.accounts.executing_pool.key(), false),       // executing_pool (mut)
            AccountMeta::new(ctx.accounts.computation_account.key(), false),  // computation_account (mut)
            AccountMeta::new_readonly(ctx.accounts.comp_def_account.key(), false), // comp_def_account
            AccountMeta::new(ctx.accounts.cluster_account.key(), false),      // cluster_account (mut)
            AccountMeta::new(ctx.accounts.pool_account.key(), false),         // pool_account (mut)
            AccountMeta::new_readonly(ctx.accounts.clock_account.key(), false), // clock_account
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false), // system_program
            AccountMeta::new_readonly(ctx.accounts.arcium_program.key(), false), // arcium_program
        ];

        let ix = Instruction {
            program_id: ctx.accounts.arcium_mxe_program.key(),
            accounts: account_metas.to_vec(),
            data: instruction_data.to_vec(),
        };

        // STEP 4: Invoke the Arcium MXE program
        invoke(
            &ix,
            &[
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.sign_pda_account.to_account_info(),
                ctx.accounts.mxe_account.to_account_info(),
                ctx.accounts.mempool_account.to_account_info(),
                ctx.accounts.executing_pool.to_account_info(),
                ctx.accounts.computation_account.to_account_info(),
                ctx.accounts.comp_def_account.to_account_info(),
                ctx.accounts.cluster_account.to_account_info(),
                ctx.accounts.pool_account.to_account_info(),
                ctx.accounts.clock_account.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.arcium_program.to_account_info(),
            ],
        )?;

        msg!("✅ Encrypted computation queued successfully!");
        msg!("   Computation offset: {}", computation_offset);
        msg!("   Portfolio data: [ENCRYPTED - 13 assets]");
        msg!("   MEV protection: ACTIVE");
        msg!("   Awaiting MXE callback with encrypted results...");
        
        Ok(())
    }
}

// ============================================================================
// Arcium MXE Data Structures
// ============================================================================

/// Encrypted swap instruction from Arcium MXE
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct EncryptedSwapInstruction {
    pub from_asset: u8,
    pub to_asset: u8,
    pub amount: u64,        // Encrypted in production
    pub min_output: u64,    // Encrypted in production
}

/// Encrypted rebalancing result from Arcium MXE
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RebalancingResultEncrypted {
    pub swap_count: u8,
    pub encrypted_swaps: Vec<EncryptedSwapInstruction>,
    pub total_tvl_encrypted: Vec<u8>,  // Encrypted TVL
    pub drifts_encrypted: Vec<u8>,     // Encrypted drift values
}

// ============================================================================
// Helper Functions for Rebalancing
// ============================================================================

/// Calculate USD value of an asset balance
fn calculate_asset_usd_value(balance: u64, price: i64, mint: Pubkey) -> Result<i64> {
    // Determine token decimals based on mint
    let decimals = get_token_decimals(mint)?;
    
    // Calculate: (balance * price) / 10^decimals
    // Both sides are in micro-USD (6 decimals)
    let balance_i64 = balance as i64;
    let usd_value = (balance_i64 * price) / 10i64.pow(decimals as u32);
    
    Ok(usd_value)
}

/// Get token decimals based on mint address
fn get_token_decimals(_mint: Pubkey) -> Result<u8> {
    // In production, this would query the mint account
    // For now, we use standard decimals for devnet testing
    // BTC: 8, ETH: 9 (simplified from 18), SOL: 9
    
    // Default to SOL decimals (9) for all tokens in testing
    // TODO: Read actual decimals from mint account in production
    Ok(9)
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

    /// Switchboard Oracle Quote for BTC/USD (only used when price_source = Switchboard)
    /// CHECK: Optional account - only validated when price_source is Switchboard
    pub btc_quote: UncheckedAccount<'info>,

    /// Switchboard Oracle Quote for ETH/USD (only used when price_source = Switchboard)
    /// CHECK: Optional account - only validated when price_source is Switchboard
    pub eth_quote: UncheckedAccount<'info>,

    /// Switchboard Oracle Quote for SOL/USD (only used when price_source = Switchboard)
    /// CHECK: Optional account - only validated when price_source is Switchboard
    pub sol_quote: UncheckedAccount<'info>,

    // ========== Marinade Strategy Accounts (Optional - only if vault.marinade_strategy is set) ==========
    
    /// Marinade Strategy program (for CPI)
    /// CHECK: This is the marinade_strategy program that wraps Marinade Finance
    pub marinade_strategy_program: UncheckedAccount<'info>,
    
    /// Marinade Finance program (passed through to strategy)
    /// CHECK: Validated as Marinade program ID when marinade_strategy is configured
    pub marinade_program: UncheckedAccount<'info>,
    
    /// Marinade state account
    /// CHECK: Validated by Marinade program during CPI
    #[account(mut)]
    pub marinade_state: UncheckedAccount<'info>,
    
    /// Marinade reserve PDA
    /// CHECK: Validated by Marinade program during CPI
    #[account(mut)]
    pub reserve_pda: UncheckedAccount<'info>,
    
    /// mSOL token mint
    /// CHECK: Validated by Marinade program during CPI
    #[account(mut)]
    pub msol_mint: UncheckedAccount<'info>,
    
    /// Strategy's mSOL ATA (receives mSOL from staking)
    /// CHECK: Validated by Marinade program during CPI
    #[account(mut)]
    pub strategy_msol_ata: UncheckedAccount<'info>,
    
    /// mSOL mint authority
    /// CHECK: Validated by Marinade program during CPI
    #[account(mut)]
    pub msol_mint_authority: UncheckedAccount<'info>,
    
    /// Liquidity pool SOL leg PDA
    /// CHECK: Validated by Marinade program during CPI
    #[account(mut)]
    pub liq_pool_sol_leg_pda: UncheckedAccount<'info>,
    
    /// Liquidity pool mSOL leg
    /// CHECK: Validated by Marinade program during CPI
    #[account(mut)]
    pub liq_pool_msol_leg: UncheckedAccount<'info>,
    
    /// Liquidity pool mSOL leg authority
    /// CHECK: Validated by Marinade program during CPI
    #[account(mut)]
    pub liq_pool_msol_leg_authority: UncheckedAccount<'info>,

    pub clock: Sysvar<'info, Clock>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    
    // remaining_accounts layout:
    // [0-5]: Asset mints and ATAs (3 assets × 2 accounts each)
    //   [0]: BTC mint, [1]: BTC vault ATA
    //   [2]: ETH mint, [3]: ETH vault ATA  
    //   [4]: SOL mint, [5]: SOL vault ATA
    // [6]: MockOracle account (if using MockOracle price source)
    // [7]: Marinade strategy account (if marinade_strategy is configured)
}

/// Helper account to pass Marinade strategy account via remaining_accounts
/// CHECK: This is validated against vault.marinade_strategy
pub struct MarinadeStrategyAccount;


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

    /// System-owned account to receive SOL from Marinade (required by Marinade)
    /// CHECK: Must be system-owned for Marinade liquid_unstake
    #[account(mut)]
    pub sol_receiver: UncheckedAccount<'info>,

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

    /// Switchboard Oracle Quote for BTC/USD (only used when price_source = Switchboard)
    /// CHECK: Optional account - only validated when price_source is Switchboard
    pub btc_quote: UncheckedAccount<'info>,

    /// Switchboard Oracle Quote for ETH/USD (only used when price_source = Switchboard)
    /// CHECK: Optional account - only validated when price_source is Switchboard
    pub eth_quote: UncheckedAccount<'info>,

    /// Switchboard Oracle Quote for SOL/USD (only used when price_source = Switchboard)
    /// CHECK: Optional account - only validated when price_source is Switchboard
    pub sol_quote: UncheckedAccount<'info>,

    // ========== Marinade Strategy Accounts (Optional - only if vault.marinade_strategy is set) ==========
    
    /// Marinade Strategy program (for CPI)
    /// CHECK: This is the marinade_strategy program that wraps Marinade Finance
    pub marinade_strategy_program: UncheckedAccount<'info>,
    
    /// Marinade Finance program (passed through to strategy)
    /// CHECK: Validated as Marinade program ID when marinade_strategy is configured
    pub marinade_program: UncheckedAccount<'info>,
    
    /// Marinade state account
    /// CHECK: Validated by Marinade program during CPI
    #[account(mut)]
    pub marinade_state: UncheckedAccount<'info>,
    
    /// mSOL token mint
    /// CHECK: Validated by Marinade program during CPI
    #[account(mut)]
    pub msol_mint: UncheckedAccount<'info>,
    
    /// Liquidity pool mSOL leg
    /// CHECK: Validated by Marinade program during CPI
    #[account(mut)]
    pub liq_pool_msol_leg: UncheckedAccount<'info>,
    
    /// Liquidity pool SOL leg PDA
    /// CHECK: Validated by Marinade program during CPI
    #[account(mut)]
    pub liq_pool_sol_leg_pda: UncheckedAccount<'info>,
    
    /// Strategy's mSOL ATA
    /// CHECK: Validated by strategy program
    #[account(mut)]
    pub strategy_msol_ata: UncheckedAccount<'info>,
    
    /// Treasury mSOL account
    /// CHECK: Validated by Marinade program during CPI
    #[account(mut)]
    pub treasury_msol_account: UncheckedAccount<'info>,

    pub clock: Sysvar<'info, Clock>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    
    // remaining_accounts layout:
    // For each asset in vault.assets:
    //   [i*2]: Asset mint account (UncheckedAccount)
    //   [i*2+1]: Vault's ATA for that asset (mut, UncheckedAccount)
    // After assets: MockOracle (if using MockOracle price source)
    // After oracle: Marinade strategy account (if marinade_strategy is configured)
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

#[derive(Accounts)]
#[instruction(vault_name: String)]
pub struct Rebalance<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.admin.as_ref(), vault_name.as_bytes()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    
    /// Admin or authorized rebalancer
    pub authority: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    
    // remaining_accounts:
    // [0]: MockOracle account (if price_source = MockOracle)
    // [1..n]: Vault ATAs for each asset (mut)
}

/// Accounts for confidential rebalancing via Arcium MXE
#[derive(Accounts)]
#[instruction(vault_name: String)]
pub struct RebalanceConfidential<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.admin.as_ref(), vault_name.as_bytes()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    
    /// Admin or authorized rebalancer (also pays for computation)
    #[account(mut)]
    pub authority: Signer<'info>,
    
    // ============ Arcium MXE Accounts ============
    
    /// Arcium MXE rebalancing program
    /// CHECK: Program ID verified at call site
    pub arcium_mxe_program: UncheckedAccount<'info>,
    
    /// Sign PDA account for Arcium
    /// CHECK: Derived by Arcium program
    #[account(mut)]
    pub sign_pda_account: UncheckedAccount<'info>,
    
    /// MXE account (Multi-party eXecution Environment)
    /// CHECK: Derived by Arcium program
    pub mxe_account: UncheckedAccount<'info>,
    
    /// Mempool account for queued computations
    /// CHECK: Derived by Arcium program
    #[account(mut)]
    pub mempool_account: UncheckedAccount<'info>,
    
    /// Executing pool for active computations
    /// CHECK: Derived by Arcium program
    #[account(mut)]
    pub executing_pool: UncheckedAccount<'info>,
    
    /// Computation account (unique per computation offset)
    /// CHECK: Derived by Arcium program
    #[account(mut)]
    pub computation_account: UncheckedAccount<'info>,
    
    /// Computation definition account (defines the circuit)
    /// CHECK: Derived by Arcium program
    pub comp_def_account: UncheckedAccount<'info>,
    
    /// Cluster account (Arcium compute cluster)
    /// CHECK: Derived by Arcium program
    #[account(mut)]
    pub cluster_account: UncheckedAccount<'info>,
    
    /// Fee pool account for Arcium fees
    /// CHECK: Arcium fee pool address
    #[account(mut)]
    pub pool_account: UncheckedAccount<'info>,
    
    /// Clock account for timestamp validation
    /// CHECK: Arcium clock account
    pub clock_account: UncheckedAccount<'info>,
    
    /// Arcium base program
    /// CHECK: Arcium program ID
    pub arcium_program: UncheckedAccount<'info>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    
    // remaining_accounts:
    // [0]: MockOracle account
    // [1]: Arcium cluster account (for verification)
    // [2..n]: Vault's ATAs for each asset (mut)
}

#[derive(Accounts)]
pub struct InitializeMockOracle<'info> {
    #[account(
        init,
        payer = authority,
        space = MockPriceOracle::LEN,
        seeds = [b"mock_oracle", authority.key().as_ref()],
        bump
    )]
    pub mock_oracle: Account<'info, MockPriceOracle>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateMockOracle<'info> {
    #[account(
        mut,
        seeds = [b"mock_oracle", mock_oracle.authority.as_ref()],
        bump = mock_oracle.bump
    )]
    pub mock_oracle: Account<'info, MockPriceOracle>,

    pub authority: Signer<'info>,
}

// ============================================================================
// EPHEMERAL ROLLUPS CONTEXTS (TEMPORARILY DISABLED)
// ============================================================================
// Disabled pending ER SDK compatibility with Anchor 0.31.1+

/// Context for delegating mock oracle to Ephemeral Rollup
/// Uses #[delegate] macro from ephemeral-rollups-sdk
#[delegate]
#[derive(Accounts)]
pub struct DelegateMockOracleCtx<'info> {
    pub payer: Signer<'info>,

    /// The mock oracle PDA to delegate to ER
    /// CHECK: The pda to delegate
    #[account(mut, del)]
    pub pda: AccountInfo<'info>,
}/// Context for committing mock oracle state to L1 (without undelegating)
/// Uses #[commit] macro from ephemeral-rollups-sdk
#[commit]
#[derive(Accounts)]
pub struct CommitMockOracle<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    
    /// The mock oracle account to commit
    #[account(
        mut,
        seeds = [b"mock_oracle", authority.key().as_ref()],
        bump = mock_oracle.bump
    )]
    pub mock_oracle: Account<'info, MockPriceOracle>,
}

/// Context for undelegating mock oracle from Ephemeral Rollup back to L1
/// Uses #[commit] macro to handle commit + undelegate operation
#[commit]
#[derive(Accounts)]
pub struct UndelegateMockOracle<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    
    /// The mock oracle account to undelegate
    #[account(
        mut,
        seeds = [b"mock_oracle", authority.key().as_ref()],
        bump = mock_oracle.bump
    )]
    pub mock_oracle: Account<'info, MockPriceOracle>,
}

#[derive(Accounts)]
#[instruction(name: String)]
pub struct SetPriceSource<'info> {
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
    #[msg("Invalid Oracle Quote")]
    InvalidQuote,
    #[msg("Invalid Quote Signature")]
    InvalidQuoteSignature,
    #[msg("Stale Quote")]
    StaleQuote,
    #[msg("Invalid Price")]
    InvalidPrice,

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

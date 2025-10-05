use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer, MintTo, Burn};
use anchor_spl::associated_token::AssociatedToken;

mod state;
use state::Vault;

// Import strategy interface types
use strategy_interface::{
    StrategyState,
    StrategyKind,
    InitializeArgs,
    StakeArgs,
    UnstakeArgs,
};

// Events
#[event]
pub struct DepositEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub shares: u64,
    pub total_assets: u64,
}

#[event]
pub struct WithdrawEvent {
    pub user: Pubkey,
    pub shares: u64,
    pub assets: u64,
    pub total_assets: u64,
}

declare_id!("AUXhyMXmb4Gwnspmtj6X97saUT2MDJAPVjKnBcipwhz2");

#[program]
pub mod vault {
    use super::*;

    /// Initialize a new SOL vault
    /// This creates a vault account for SOL deposits
    pub fn initialize_sol_vault(ctx: Context<InitializeSolVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        
        // Initialize vault with provided parameters
        vault.authority = ctx.accounts.authority.key();
        vault.vault_token_mint = ctx.accounts.vault_token_mint.key();
        vault.total_assets = 0;
        vault.underlying_asset_mint = None; // SOL vault
        vault.strategy = None; // No strategy initially
        vault.bump = ctx.bumps.vault;

        msg!("SOL Vault initialized with authority: {}", vault.authority);
        msg!("Vault token mint: {}", vault.vault_token_mint);
        
        Ok(())
    }

    /// Initialize a new SPL token vault
    /// This creates a vault account for SPL token deposits
    pub fn initialize_spl_vault(ctx: Context<InitializeSplVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        
        // Initialize vault with provided parameters
        vault.authority = ctx.accounts.authority.key();
        vault.vault_token_mint = ctx.accounts.vault_token_mint.key();
        vault.total_assets = 0;
        vault.underlying_asset_mint = Some(ctx.accounts.underlying_asset_mint.key());
        vault.strategy = None; // No strategy initially
        vault.bump = ctx.bumps.vault;

        msg!("SPL Vault initialized with authority: {}", vault.authority);
        msg!("Vault token mint: {}", vault.vault_token_mint);
        msg!("Underlying asset mint: {}", ctx.accounts.underlying_asset_mint.key());
        
        Ok(())
    }

    /// Deposit assets into the vault and receive proportional shares
    /// For SOL deposits, the amount is in lamports
    /// For SPL token deposits, the amount is in the token's smallest unit
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidAmount);

        // Get vault info for transfer logic
        let vault_info = ctx.accounts.vault.to_account_info();
        let is_sol_vault = ctx.accounts.vault.underlying_asset_mint.is_none();

        // Transfer underlying assets to vault
        if !is_sol_vault {
            // SPL token deposit
            let transfer_ctx = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_underlying_token_account.as_ref().unwrap().to_account_info(),
                    to: ctx.accounts.vault_underlying_token_account.as_ref().unwrap().to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            );
            token::transfer(transfer_ctx, amount)?;
        } else {
            // SOL deposit - transfer lamports from user to vault
            let transfer_ctx = CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: vault_info,
                },
            );
            system_program::transfer(transfer_ctx, amount)?;
        }

        let vault = &mut ctx.accounts.vault;
        let vault_token_mint = &mut ctx.accounts.vault_token_mint;
        let user_vault_token_account = &mut ctx.accounts.user_vault_token_account;

        // Calculate shares to mint based on current vault state
        let shares_to_mint = if vault.total_assets == 0 {
            // First deposit: 1:1 ratio
            amount
        } else {
            // Calculate proportional shares: (amount * total_supply) / total_assets
            let total_supply = vault_token_mint.supply;
            amount
                .checked_mul(total_supply)
                .ok_or(VaultError::MathOverflow)?
                .checked_div(vault.total_assets)
                .ok_or(VaultError::MathOverflow)?
        };

        // Mint vault shares to user
        let mint_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: vault_token_mint.to_account_info(),
                to: user_vault_token_account.to_account_info(),
                authority: vault.to_account_info(),
            },
        );
        let seeds = &[
            b"vault",
            vault.authority.as_ref(),
            &[vault.bump],
        ];
        let signer = &[&seeds[..]];
        token::mint_to(mint_ctx.with_signer(signer), shares_to_mint)?;

        // Update vault total assets
        vault.total_assets = vault.total_assets
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;

        // If strategy is configured, delegate the assets to the strategy
        if let Some(strategy_pubkey) = vault.strategy {
            msg!("Delegating {} assets to strategy: {}", amount, strategy_pubkey);
            
            // Call strategy's stake function
            // Note: This is a placeholder for now - actual strategy calls will be implemented
            // when specific strategies (Marinade, Katana, etc.) are added
            // For now, we just log that we would delegate to the strategy
            msg!("Strategy delegation would happen here for strategy: {}", strategy_pubkey);
        }

        msg!("Deposited {} assets, received {} shares", amount, shares_to_mint);
        msg!("New total assets: {}", vault.total_assets);

        // Emit deposit event
        emit!(DepositEvent {
            user: ctx.accounts.user.key(),
            amount,
            shares: shares_to_mint,
            total_assets: vault.total_assets,
        });

        Ok(())
    }

    /// Set a strategy for the vault (only callable by vault authority)
    /// This allows the vault to delegate asset management to a strategy
    pub fn set_strategy(ctx: Context<SetStrategy>, strategy: Pubkey) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        
        // Only vault authority can set strategy
        require!(
            ctx.accounts.authority.key() == vault.authority,
            VaultError::Unauthorized
        );
        
        vault.strategy = Some(strategy);
        
        msg!("Strategy set for vault: {}", strategy);
        
        Ok(())
    }

    /// Remove strategy from vault (only callable by vault authority)
    /// This makes the vault work standalone without delegation
    pub fn remove_strategy(ctx: Context<RemoveStrategy>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        
        // Only vault authority can remove strategy
        require!(
            ctx.accounts.authority.key() == vault.authority,
            VaultError::Unauthorized
        );
        
        vault.strategy = None;
        
        msg!("Strategy removed from vault");
        
        Ok(())
    }

    /// Withdraw assets from the vault by burning shares
    /// Burn shares to withdraw proportional assets (in lamports for SOL, tokens for SPL)
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidAmount);

        // Get vault info and check user shares before taking mutable references
        let vault_info = ctx.accounts.vault.to_account_info();
        let is_sol_vault = ctx.accounts.vault.underlying_asset_mint.is_none();
        
        // Check if user has sufficient shares
        require!(
            ctx.accounts.user_vault_token_account.amount >= amount,
            VaultError::InsufficientShares
        );

        // Now take mutable references
        let vault = &mut ctx.accounts.vault;
        let vault_token_mint = &mut ctx.accounts.vault_token_mint;
        let user_vault_token_account = &mut ctx.accounts.user_vault_token_account;

        // Calculate assets to withdraw (proportional to shares being burned)
        let assets_to_withdraw = if vault_token_mint.supply == amount {
            // If burning all shares, withdraw all assets
            vault.total_assets
        } else {
            // Calculate proportional assets: (amount * total_assets) / total_supply
            amount
                .checked_mul(vault.total_assets)
                .ok_or(VaultError::MathOverflow)?
                .checked_div(vault_token_mint.supply)
                .ok_or(VaultError::MathOverflow)?
        };

        // Burn vault shares from user
        let burn_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: vault_token_mint.to_account_info(),
                from: user_vault_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::burn(burn_ctx, amount)?;

        // Prepare vault PDA signer for asset transfers
        let seeds = &[
            b"vault",
            vault.authority.as_ref(),
            &[vault.bump],
        ];
        let signer = &[&seeds[..]];

        // Transfer underlying assets to user
        if !is_sol_vault {
            // SPL token withdrawal
            let transfer_ctx = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_underlying_token_account.as_ref().unwrap().to_account_info(),
                    to: ctx.accounts.user_underlying_token_account.as_ref().unwrap().to_account_info(),
                    authority: vault.to_account_info(),
                },
            );
            token::transfer(transfer_ctx.with_signer(signer), assets_to_withdraw)?;
        } else {
            // SOL withdrawal - transfer lamports from vault to user
            // For PDAs with data, we can't use system_program::transfer
            // Instead, we modify lamport balances directly
            **vault_info.try_borrow_mut_lamports()? -= assets_to_withdraw;
            **ctx.accounts.user.to_account_info().try_borrow_mut_lamports()? += assets_to_withdraw;
        }

        // If strategy is configured, withdraw assets from the strategy first
        if let Some(strategy_pubkey) = vault.strategy {
            msg!("Withdrawing {} assets from strategy: {}", assets_to_withdraw, strategy_pubkey);
            
            // Call strategy's unstake function
            // Note: This is a placeholder for now - actual strategy calls will be implemented
            // when specific strategies (Marinade, Katana, etc.) are added
            // For now, we just log that we would withdraw from the strategy
            msg!("Strategy withdrawal would happen here for strategy: {}", strategy_pubkey);
        }

        // Update vault total assets
        vault.total_assets = vault.total_assets
            .checked_sub(assets_to_withdraw)
            .ok_or(VaultError::MathOverflow)?;

        msg!("Burned {} shares, withdrew {} assets", amount, assets_to_withdraw);
        msg!("New total assets: {}", vault.total_assets);

        // Emit withdraw event
        emit!(WithdrawEvent {
            user: ctx.accounts.user.key(),
            shares: amount,
            assets: assets_to_withdraw,
            total_assets: vault.total_assets,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeSolVault<'info> {
    #[account(
        init,
        payer = authority,
        space = Vault::SPACE,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    #[account(
        init,
        payer = authority,
        mint::decimals = 6,
        mint::authority = vault,
        seeds = [b"vault_mint", authority.key().as_ref()],
        bump
    )]
    pub vault_token_mint: Account<'info, Mint>,
    
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitializeSplVault<'info> {
    #[account(
        init,
        payer = authority,
        space = Vault::SPACE,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    #[account(
        init,
        payer = authority,
        mint::decimals = 6,
        mint::authority = vault,
        seeds = [b"vault_mint", authority.key().as_ref()],
        bump
    )]
    pub vault_token_mint: Account<'info, Mint>,
    
    #[account(
        init,
        payer = authority,
        associated_token::mint = underlying_asset_mint,
        associated_token::authority = vault
    )]
    pub vault_underlying_token_account: Account<'info, TokenAccount>,
    
    #[account(mut)]
    pub underlying_asset_mint: Account<'info, Mint>,
    
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.authority.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    
    #[account(mut)]
    pub vault_token_mint: Account<'info, Mint>,
    
    #[account(mut)]
    pub user: Signer<'info>,
    
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = vault_token_mint,
        associated_token::authority = user
    )]
    pub user_vault_token_account: Account<'info, TokenAccount>,
    
    #[account(mut)]
    pub user_underlying_token_account: Option<Account<'info, TokenAccount>>,
    
    #[account(mut)]
    pub vault_underlying_token_account: Option<Account<'info, TokenAccount>>,
    
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.authority.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    
    #[account(mut)]
    pub vault_token_mint: Account<'info, Mint>,
    
    #[account(mut)]
    pub user: Signer<'info>,
    
    #[account(
        mut,
        associated_token::mint = vault_token_mint,
        associated_token::authority = user
    )]
    pub user_vault_token_account: Account<'info, TokenAccount>,
    
    // For SPL token withdrawals - make these optional
    #[account(mut)]
    pub user_underlying_token_account: Option<Account<'info, TokenAccount>>,
    
    #[account(mut)]
    pub vault_underlying_token_account: Option<Account<'info, TokenAccount>>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetStrategy<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.authority.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RemoveStrategy<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.authority.as_ref()],
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
}
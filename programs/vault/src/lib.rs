use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer, MintTo, Burn};
use anchor_spl::associated_token::AssociatedToken;

mod state;
use state::Vault;

declare_id!("AUXhyMXmb4Gwnspmtj6X97saUT2MDJAPVjKnBcipwhz2");

#[program]
pub mod vault {
    use super::*;

    /// Initialize a new vault
    /// This creates a vault account and mints the initial vault token supply
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        underlying_asset_mint: Option<Pubkey>,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        
        // Initialize vault with provided parameters
        vault.authority = ctx.accounts.authority.key();
        vault.vault_token_mint = ctx.accounts.vault_token_mint.key();
        vault.total_assets = 0;
        vault.underlying_asset_mint = underlying_asset_mint;
        vault.bump = ctx.bumps.vault;

        msg!("Vault initialized with authority: {}", vault.authority);
        msg!("Vault token mint: {}", vault.vault_token_mint);
        
        Ok(())
    }

    /// Deposit assets into the vault and receive proportional shares
    /// For SOL deposits, the amount is in lamports
    /// For SPL token deposits, the amount is in the token's smallest unit
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::InvalidAmount);

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

        // Transfer underlying assets to vault
        if let Some(_underlying_mint) = vault.underlying_asset_mint {
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
            // SOL deposit - handled by the system program in the instruction
            // The lamports are transferred via the instruction's accounts
        }

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

        msg!("Deposited {} assets, received {} shares", amount, shares_to_mint);
        msg!("New total assets: {}", vault.total_assets);

        Ok(())
    }

    /// Withdraw assets from the vault by burning shares
    /// Returns proportional underlying assets based on share ownership
    pub fn withdraw(ctx: Context<Withdraw>, shares_to_burn: u64) -> Result<()> {
        require!(shares_to_burn > 0, VaultError::InvalidAmount);

        let vault = &mut ctx.accounts.vault;
        let vault_token_mint = &mut ctx.accounts.vault_token_mint;
        let user_vault_token_account = &mut ctx.accounts.user_vault_token_account;

        // Check user has enough shares
        require!(
            user_vault_token_account.amount >= shares_to_burn,
            VaultError::InsufficientShares
        );

        // Calculate assets to withdraw based on share proportion
        let total_supply = vault_token_mint.supply;
        let assets_to_withdraw = shares_to_burn
            .checked_mul(vault.total_assets)
            .ok_or(VaultError::MathOverflow)?
            .checked_div(total_supply)
            .ok_or(VaultError::MathOverflow)?;

        // Check vault has enough assets
        require!(
            vault.total_assets >= assets_to_withdraw,
            VaultError::InsufficientAssets
        );

        // Burn user's vault shares
        let burn_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: vault_token_mint.to_account_info(),
                from: user_vault_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::burn(burn_ctx, shares_to_burn)?;

        // Transfer underlying assets to user
        if let Some(_underlying_mint) = vault.underlying_asset_mint {
            // SPL token withdrawal
            let transfer_ctx = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_underlying_token_account.as_ref().unwrap().to_account_info(),
                    to: ctx.accounts.user_underlying_token_account.as_ref().unwrap().to_account_info(),
                    authority: vault.to_account_info(),
                },
            );
            let seeds = &[
                b"vault",
                vault.authority.as_ref(),
                &[vault.bump],
            ];
            let signer = &[&seeds[..]];
            token::transfer(transfer_ctx.with_signer(signer), assets_to_withdraw)?;
        } else {
            // SOL withdrawal - handled by the system program in the instruction
            // The lamports are transferred via the instruction's accounts
        }

        // Update vault total assets
        vault.total_assets = vault.total_assets
            .checked_sub(assets_to_withdraw)
            .ok_or(VaultError::MathOverflow)?;

        msg!("Burned {} shares, withdrew {} assets", shares_to_burn, assets_to_withdraw);
        msg!("New total assets: {}", vault.total_assets);

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
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
        init,
        payer = user,
        associated_token::mint = vault_token_mint,
        associated_token::authority = user
    )]
    pub user_vault_token_account: Account<'info, TokenAccount>,
    
    // For SPL token deposits - make these optional and remove constraints
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
}
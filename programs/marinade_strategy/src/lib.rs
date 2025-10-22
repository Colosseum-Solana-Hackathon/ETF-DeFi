use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use anchor_spl::associated_token::AssociatedToken;
use marinade_cpi::program::MarinadeFinance;
use marinade_cpi::cpi::accounts::{Deposit, LiquidUnstake};
use marinade_cpi::cpi::{deposit as marinade_deposit, liquid_unstake as marinade_liquid_unstake};

declare_id!("5QSX9wJvzkDzCT8mGewJGXgtiN7Hq4DqN4VZFhRiWuJh");

// Marinade Finance program ID (mainnet/devnet)
pub const MARINADE_PROGRAM_ID: &str = "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD";

// mSOL mint address (mainnet/devnet)
pub const MSOL_MINT: &str = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";

#[program]
pub mod marinade_strategy {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let strategy = &mut ctx.accounts.strategy_account;
        strategy.bump = ctx.bumps.strategy_account;
        strategy.vault = ctx.accounts.vault.key();
        strategy.total_staked = 0;
        strategy.msol_balance = 0;
        
        msg!("Marinade strategy initialized for vault: {}", strategy.vault);
        Ok(())
    }

    /// Deposit SOL to Marinade and receive mSOL
    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::ZeroAmount);
        
        msg!("Staking {} lamports to Marinade", amount);
        
        // Build CPI context for Marinade deposit
        let vault_key = ctx.accounts.vault.key();
        let seeds = &[
            b"marinade_strategy",
            vault_key.as_ref(),
            &[ctx.accounts.strategy_account.bump],
        ];
        let signer = &[&seeds[..]];
        
        let cpi_accounts = Deposit {
            state: ctx.accounts.marinade_state.to_account_info(),
            msol_mint: ctx.accounts.msol_mint.to_account_info(),
            liq_pool_sol_leg_pda: ctx.accounts.liq_pool_sol_leg_pda.to_account_info(),
            liq_pool_msol_leg: ctx.accounts.liq_pool_msol_leg.to_account_info(),
            liq_pool_msol_leg_authority: ctx.accounts.liq_pool_msol_leg_authority.to_account_info(),
            reserve_pda: ctx.accounts.reserve_pda.to_account_info(),
            transfer_from: ctx.accounts.payer.to_account_info(),
            mint_to: ctx.accounts.msol_ata.to_account_info(),
            msol_mint_authority: ctx.accounts.msol_mint_authority.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        };
        
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.marinade_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        
        // Call Marinade deposit instruction
        marinade_deposit(cpi_ctx, amount)?;
        
        // Update strategy state
        let strategy = &mut ctx.accounts.strategy_account;
        strategy.total_staked = strategy.total_staked.checked_add(amount)
            .ok_or(ErrorCode::MathOverflow)?;
        
        // Refresh mSOL balance
        ctx.accounts.msol_ata.reload()?;
        strategy.msol_balance = ctx.accounts.msol_ata.amount;
        
        msg!("Staked {} lamports, received mSOL. Total staked: {}", amount, strategy.total_staked);
        
        Ok(())
    }

    /// Liquid unstake: Exchange mSOL for SOL through Marinade's liquidity pool
    /// Note: Marinade requires a system-owned account to receive SOL
    /// So we receive in the vault account (which should be a system account or passed through properly)
    pub fn unstake(ctx: Context<Unstake>, msol_amount: u64) -> Result<()> {
        require!(msol_amount > 0, ErrorCode::ZeroAmount);
        
        let strategy = &ctx.accounts.strategy_account;
        require!(ctx.accounts.msol_ata.amount >= msol_amount, ErrorCode::InsufficientMsol);
        
        msg!("Liquid unstaking {} mSOL from Marinade", msol_amount);
        
        let vault_key = ctx.accounts.vault.key();
        let seeds = &[
            b"marinade_strategy",
            vault_key.as_ref(),
            &[strategy.bump],
        ];
        let signer = &[&seeds[..]];
        
        // Record receiver balance before unstaking
        let receiver_balance_before = ctx.accounts.sol_receiver.lamports();
        
        // Marinade liquid_unstake requires transfer_sol_to to be system-owned
        let cpi_accounts = LiquidUnstake {
            state: ctx.accounts.marinade_state.to_account_info(),
            msol_mint: ctx.accounts.msol_mint.to_account_info(),
            liq_pool_sol_leg_pda: ctx.accounts.liq_pool_sol_leg_pda.to_account_info(),
            liq_pool_msol_leg: ctx.accounts.liq_pool_msol_leg.to_account_info(),
            treasury_msol_account: ctx.accounts.treasury_msol_account.to_account_info(),
            get_msol_from: ctx.accounts.msol_ata.to_account_info(),
            get_msol_from_authority: ctx.accounts.strategy_account.to_account_info(),
            transfer_sol_to: ctx.accounts.sol_receiver.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        };
        
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.marinade_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        
        // Call Marinade liquid_unstake instruction
        marinade_liquid_unstake(cpi_ctx, msol_amount)?;
        
        // Calculate SOL received
        let receiver_balance_after = ctx.accounts.sol_receiver.lamports();
        let sol_received = receiver_balance_after.saturating_sub(receiver_balance_before);
        
        // SOL is already in the receiver account, no need to transfer
        // The receiver should be the final destination (user account)
        
        msg!("Liquid unstaked {} mSOL, received {} lamports SOL", msol_amount, sol_received);
        
        Ok(())
    }

    pub fn harvest(_ctx: Context<Harvest>) -> Result<u64> {
        // Marinade doesn't require explicit harvest - yields accrue to mSOL price
        // The value increase is reflected in report_value()
        Ok(0)
    }

    /// Calculate the SOL value of held mSOL using Marinade's state
    pub fn report_value(ctx: Context<ReportValue>) -> Result<u64> {
        let msol_balance = ctx.accounts.msol_ata.amount;
        
        // Get Marinade state to calculate mSOL -> SOL conversion
        // Marinade state contains: msol_supply, total_cooling_down, total_lamports_under_control, etc.
        // Conversion rate = total_lamports_under_control / msol_supply
        
        // For now, we'll return the mSOL balance directly
        // TODO: Parse Marinade state account to get accurate SOL value
        let _marinade_state_data = ctx.accounts.marinade_state.try_borrow_data()?;
        
        // Simplified calculation (this should parse the actual Marinade state)
        // In production, you'd deserialize the Marinade state struct
        let sol_value = msol_balance; // Placeholder - should be: msol_balance * exchange_rate
        
        msg!("mSOL balance: {}, estimated SOL value: {}", msol_balance, sol_value);
        
        Ok(sol_value)
    }

    /// Close strategy account and return lamports to payer
    pub fn close_strategy(_ctx: Context<CloseStrategy>) -> Result<()> {
        msg!("Closing strategy account");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + StrategyAccount::INIT_SPACE,
        seeds = [b"marinade_strategy", vault.key().as_ref()],
        bump
    )]
    pub strategy_account: Account<'info, StrategyAccount>,
    
    /// CHECK: Vault program account
    pub vault: AccountInfo<'info>,
    
    #[account(mut)]
    pub payer: Signer<'info>,
    
    pub system_program: Program<'info, System>,
    
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::authority = strategy_account,
        associated_token::mint = msol_mint
    )]
    pub msol_ata: Account<'info, TokenAccount>,
    
    pub msol_mint: Account<'info, Mint>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(
        mut,
        seeds = [b"marinade_strategy", vault.key().as_ref()],
        bump = strategy_account.bump,
        constraint = strategy_account.vault == vault.key()
    )]
    pub strategy_account: Account<'info, StrategyAccount>,
    
    /// CHECK: Vault program account (authority for funds)
    #[account(mut)]
    pub vault: AccountInfo<'info>,
    
    /// Payer for transaction fees and rent
    #[account(mut, signer)]
    pub payer: Signer<'info>,
    
    /// CHECK: Marinade state account - validated by Marinade program
    #[account(mut)]
    pub marinade_state: AccountInfo<'info>,
    
    /// CHECK: Marinade reserve PDA - validated by Marinade program
    #[account(mut)]
    pub reserve_pda: AccountInfo<'info>,
    
    #[account(mut)]
    pub msol_mint: Account<'info, Mint>,
    
    #[account(
        mut,
        associated_token::authority = strategy_account,
        associated_token::mint = msol_mint
    )]
    pub msol_ata: Account<'info, TokenAccount>,
    
    /// CHECK: mSOL mint authority - validated by Marinade program
    #[account(mut)]
    pub msol_mint_authority: AccountInfo<'info>,
    
    /// CHECK: Liquidity pool SOL leg PDA - validated by Marinade program
    #[account(mut)]
    pub liq_pool_sol_leg_pda: AccountInfo<'info>,
    
    /// CHECK: Liquidity pool mSOL leg - validated by Marinade program
    #[account(mut)]
    pub liq_pool_msol_leg: Account<'info, TokenAccount>,
    
    /// CHECK: Liquidity pool mSOL leg authority - validated by Marinade program
    #[account(mut)]
    pub liq_pool_msol_leg_authority: AccountInfo<'info>,
    
    /// CHECK: Marinade program
    pub marinade_program: AccountInfo<'info>,
    
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(
        mut,
        seeds = [b"marinade_strategy", vault.key().as_ref()],
        bump = strategy_account.bump,
        constraint = strategy_account.vault == vault.key()
    )]
    pub strategy_account: Account<'info, StrategyAccount>,
    
    /// CHECK: Vault program account (final destination for SOL)
    #[account(mut)]
    pub vault: AccountInfo<'info>,
    
    /// System-owned account to receive SOL from Marinade (required by Marinade)
    /// This will typically be the vault PDA passed as an UncheckedAccount
    /// CHECK: Must be system-owned for Marinade to transfer SOL
    #[account(mut)]
    pub sol_receiver: AccountInfo<'info>,
    
    /// CHECK: Marinade state account - validated by Marinade program
    #[account(mut)]
    pub marinade_state: AccountInfo<'info>,
    
    #[account(mut)]
    pub msol_mint: Account<'info, Mint>,
    
    /// CHECK: Liquidity pool mSOL leg - validated by Marinade program
    #[account(mut)]
    pub liq_pool_msol_leg: Account<'info, TokenAccount>,
    
    /// CHECK: Liquidity pool SOL leg PDA - validated by Marinade program
    #[account(mut)]
    pub liq_pool_sol_leg_pda: AccountInfo<'info>,
    
    #[account(
        mut,
        associated_token::authority = strategy_account,
        associated_token::mint = msol_mint
    )]
    pub msol_ata: Account<'info, TokenAccount>,
    
    /// CHECK: Treasury mSOL account - validated by Marinade program
    #[account(mut)]
    pub treasury_msol_account: Account<'info, TokenAccount>,
    
    /// CHECK: Marinade program
    pub marinade_program: AccountInfo<'info>,
    
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Harvest<'info> {
    #[account(
        seeds = [b"marinade_strategy", vault.key().as_ref()],
        bump = strategy_account.bump,
        constraint = strategy_account.vault == vault.key()
    )]
    pub strategy_account: Account<'info, StrategyAccount>,
    
    /// CHECK: Vault program account
    pub vault: AccountInfo<'info>,
    
    /// CHECK: Marinade state account
    pub marinade_state: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ReportValue<'info> {
    #[account(
        seeds = [b"marinade_strategy", vault.key().as_ref()],
        bump = strategy_account.bump,
        constraint = strategy_account.vault == vault.key()
    )]
    pub strategy_account: Account<'info, StrategyAccount>,
    
    /// CHECK: Vault program account
    pub vault: AccountInfo<'info>,
    
    /// CHECK: Marinade state account
    pub marinade_state: AccountInfo<'info>,
    
    #[account(
        associated_token::authority = strategy_account,
        associated_token::mint = msol_mint
    )]
    pub msol_ata: Account<'info, TokenAccount>,
    
    pub msol_mint: Account<'info, Mint>,
}

#[account]
#[derive(InitSpace)]
pub struct StrategyAccount {
    pub bump: u8,
    pub vault: Pubkey,
    pub total_staked: u64,
    pub msol_balance: u64,
}

#[derive(Accounts)]
pub struct CloseStrategy<'info> {
    #[account(
        mut,
        close = payer,
        seeds = [b"marinade_strategy", vault.key().as_ref()],
        bump = strategy_account.bump,
        constraint = strategy_account.vault == vault.key()
    )]
    pub strategy_account: Account<'info, StrategyAccount>,
    
    /// Vault program account (authority for funds)
    #[account(mut)]
    pub vault: AccountInfo<'info>,
    
    /// Payer to receive the closed account's lamports
    #[account(mut, signer)]
    pub payer: Signer<'info>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Insufficient mSOL balance")]
    InsufficientMsol,
    #[msg("Math overflow")]
    MathOverflow,
}
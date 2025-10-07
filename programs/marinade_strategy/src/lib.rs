use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::token::{Mint, Token, TokenAccount};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("H1Z8qhsV7SLPkmB8g3RtQ5yunzTiHQCCQyS9Sh5SPLpn");

// Marinade Finance program ID (mainnet/devnet)
pub const MARINADE_PROGRAM_ID: &str = "MarBmsSgKXdruk9RqBmHFrCAB8yMdQxPR9e7Q5Zz2vSPn";

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
        
        // Marinade deposit instruction discriminator
        // This calls marinade_finance::deposit
        let mut deposit_data = vec![0xf2, 0x23, 0xc6, 0x89, 0x6e, 0x38, 0xc4, 0xf6];
        deposit_data.extend_from_slice(&amount.to_le_bytes());
        
        let marinade_program_id = ctx.accounts.marinade_program.key();
        
        let deposit_ix = Instruction {
            program_id: marinade_program_id,
            accounts: vec![
                AccountMeta::new(ctx.accounts.marinade_state.key(), false),
                AccountMeta::new(ctx.accounts.msol_mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.liq_pool_sol_leg_pda.key(), false),
                AccountMeta::new(ctx.accounts.liq_pool_msol_leg.key(), false),
                AccountMeta::new(ctx.accounts.liq_pool_msol_leg_authority.key(), false),
                AccountMeta::new(ctx.accounts.reserve_pda.key(), false),
                AccountMeta::new(ctx.accounts.strategy_account.key(), true), // Transfer authority
                AccountMeta::new(ctx.accounts.msol_ata.key(), false),
                AccountMeta::new_readonly(ctx.accounts.msol_mint_authority.key(), false),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            ],
            data: deposit_data,
        };
        
        let vault_key = ctx.accounts.vault.key();
        let seeds = &[
            b"marinade_strategy",
            vault_key.as_ref(),
            &[ctx.accounts.strategy_account.bump],
        ];
        let signer = &[&seeds[..]];
        
        invoke_signed(
            &deposit_ix,
            &[
                ctx.accounts.marinade_state.to_account_info(),
                ctx.accounts.msol_mint.to_account_info(),
                ctx.accounts.liq_pool_sol_leg_pda.to_account_info(),
                ctx.accounts.liq_pool_msol_leg.to_account_info(),
                ctx.accounts.liq_pool_msol_leg_authority.to_account_info(),
                ctx.accounts.reserve_pda.to_account_info(),
                ctx.accounts.strategy_account.to_account_info(),
                ctx.accounts.msol_ata.to_account_info(),
                ctx.accounts.msol_mint_authority.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            signer,
        )?;
        
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
    pub fn unstake(ctx: Context<Unstake>, msol_amount: u64) -> Result<()> {
        require!(msol_amount > 0, ErrorCode::ZeroAmount);
        
        let strategy = &ctx.accounts.strategy_account;
        require!(ctx.accounts.msol_ata.amount >= msol_amount, ErrorCode::InsufficientMsol);
        
        msg!("Liquid unstaking {} mSOL from Marinade", msol_amount);
        
        // Marinade liquid_unstake instruction discriminator
        let mut unstake_data = vec![0xdd, 0x53, 0xf1, 0x3c, 0xd4, 0xc7, 0x5e, 0x9d];
        unstake_data.extend_from_slice(&msol_amount.to_le_bytes());
        
        let marinade_program_id = ctx.accounts.marinade_program.key();
        
        let unstake_ix = Instruction {
            program_id: marinade_program_id,
            accounts: vec![
                AccountMeta::new(ctx.accounts.marinade_state.key(), false),
                AccountMeta::new(ctx.accounts.msol_mint.key(), false),
                AccountMeta::new(ctx.accounts.liq_pool_sol_leg_pda.key(), false),
                AccountMeta::new(ctx.accounts.liq_pool_msol_leg.key(), false),
                AccountMeta::new(ctx.accounts.treasury_msol_account.key(), false),
                AccountMeta::new(ctx.accounts.msol_ata.key(), false),
                AccountMeta::new(ctx.accounts.strategy_account.key(), true),
                AccountMeta::new(ctx.accounts.vault.key(), false), // Receives SOL
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            ],
            data: unstake_data,
        };
        
        let vault_key = ctx.accounts.vault.key();
        let seeds = &[
            b"marinade_strategy",
            vault_key.as_ref(),
            &[strategy.bump],
        ];
        let signer = &[&seeds[..]];
        
        invoke_signed(
            &unstake_ix,
            &[
                ctx.accounts.marinade_state.to_account_info(),
                ctx.accounts.msol_mint.to_account_info(),
                ctx.accounts.liq_pool_sol_leg_pda.to_account_info(),
                ctx.accounts.liq_pool_msol_leg.to_account_info(),
                ctx.accounts.treasury_msol_account.to_account_info(),
                ctx.accounts.msol_ata.to_account_info(),
                ctx.accounts.strategy_account.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            signer,
        )?;
        
        msg!("Liquid unstaked {} mSOL", msol_amount);
        
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
        let marinade_state_data = ctx.accounts.marinade_state.try_borrow_data()?;
        
        // Simplified calculation (this should parse the actual Marinade state)
        // In production, you'd deserialize the Marinade state struct
        let sol_value = msol_balance; // Placeholder - should be: msol_balance * exchange_rate
        
        msg!("mSOL balance: {}, estimated SOL value: {}", msol_balance, sol_value);
        
        Ok(sol_value)
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
    pub msol_mint_authority: AccountInfo<'info>,
    
    /// CHECK: Liquidity pool SOL leg PDA - validated by Marinade program
    #[account(mut)]
    pub liq_pool_sol_leg_pda: AccountInfo<'info>,
    
    /// CHECK: Liquidity pool mSOL leg - validated by Marinade program
    #[account(mut)]
    pub liq_pool_msol_leg: Account<'info, TokenAccount>,
    
    /// CHECK: Liquidity pool mSOL leg authority - validated by Marinade program
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
    
    /// CHECK: Vault program account (receives SOL)
    #[account(mut)]
    pub vault: AccountInfo<'info>,
    
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

#[error_code]
pub enum ErrorCode {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Insufficient mSOL balance")]
    InsufficientMsol,
    #[msg("Math overflow")]
    MathOverflow,
}